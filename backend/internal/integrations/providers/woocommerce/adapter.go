package woocommerce

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/theroisey/else/backend/internal/integrations/providerhttp"
	"github.com/theroisey/else/backend/internal/integrations/providers/internal/jsonvalue"
)

const ordersPath = "/wp-json/wc/v3/orders"
const refundsPath = "/wp-json/wc/v3/refunds"
const orderFields = "id,status,currency,date_created_gmt,total,refunds.id,refunds.total,line_items.id,line_items.product_id,line_items.variation_id,line_items.quantity,line_items.total,line_items.total_tax"
const refundFields = "id,parent_id,date_created_gmt,amount"
const collectionBudget = 120 * time.Second

type collectionClient interface {
	DoPage(context.Context, string, url.Values, string) (providerhttp.PageResult, error)
}

type Adapter struct {
	client collectionClient
	now    func() time.Time
}

func (a *Adapter) String() string             { return "<WooCommerce collector>" }
func (a *Adapter) Format(s fmt.State, _ rune) { _, _ = io.WriteString(s, a.String()) }

// NewAdapter binds a trusted stored immutable store origin. It has no production
// caller HTTP/resolver/trust hook and does not request anything at construction.
func NewAdapter(origin string, admission *providerhttp.Admission) (*Adapter, error) {
	client, err := providerhttp.New(origin, admission)
	if err != nil {
		return nil, ErrUnavailable
	}
	return &Adapter{client: client, now: time.Now}, nil
}

type Workspace struct {
	Orders           OrderReport   `json:"orders"`
	Refunds          RefundReport  `json:"refunds"`
	Products         ProductReport `json:"products"`
	CollectedFrom    time.Time     `json:"collected_from"`
	CollectedThrough time.Time     `json:"collected_through"`
}

// Fetch collects observed cohorts atomically; it does not claim a transactional
// provider snapshot, legal ownership, key scope, recognized revenue or payment.
func (a *Adapter) Fetch(ctx context.Context, key *ReadKey, expectation Expectation) (Workspace, error) {
	return a.fetch(ctx, key, expectation, nil)
}

// FetchFenced checks fresh stored authority/generation before every request.
// The caller's fence must end its database transaction before returning.
func (a *Adapter) FetchFenced(ctx context.Context, key *ReadKey, expectation Expectation, fence func(context.Context) bool) (Workspace, error) {
	if fence == nil {
		return Workspace{}, ErrUnavailable
	}
	return a.fetch(ctx, key, expectation, fence)
}

func (a *Adapter) fetch(ctx context.Context, key *ReadKey, e Expectation, fence func(context.Context) bool) (Workspace, error) {
	if a == nil || a.client == nil || a.now == nil || ctx == nil || ctx.Err() != nil || e.PerPage != 100 {
		return Workspace{}, ErrUnavailable
	}
	if _, valid := validExpectation(e); !valid {
		return Workspace{}, ErrUnavailable
	}
	authorization, valid := key.authorization()
	if !valid {
		return Workspace{}, ErrUnavailable
	}
	bounded, cancel := context.WithTimeout(ctx, collectionBudget)
	defer cancel()
	started := a.now().UTC().Truncate(time.Microsecond)
	query := periodQuery(e)
	query.Set("_fields", orderFields)
	orders, err := a.collect(bounded, authorization, ordersPath, query, fence)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	defer clearPages(orders)
	orderReport, productReport, err := NormalizeOrdersAndProducts(e, orders)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	refundQuery := periodQuery(e)
	refundQuery.Set("_fields", refundFields)
	refunds, err := a.collect(bounded, authorization, refundsPath, refundQuery, fence)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	defer clearPages(refunds)
	ids, valid := refundParentIDs(e, refunds)
	if !valid {
		return Workspace{}, ErrUnavailable
	}
	parents, err := a.parents(bounded, authorization, e.Currency, ids, fence)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	refundReport, err := NormalizeRefunds(e, refunds, parents)
	if err != nil {
		return Workspace{}, ErrUnavailable
	}
	// Detect observed head/count changes. WordPress makes no multi-request
	// snapshot promise; unchanged first pages cannot prove untouched later rows.
	if !a.unchanged(bounded, authorization, ordersPath, query, orders[0], fence) || !a.unchanged(bounded, authorization, refundsPath, refundQuery, refunds[0], fence) || bounded.Err() != nil {
		return Workspace{}, ErrUnavailable
	}
	finished := a.now().UTC().Truncate(time.Microsecond)
	if finished.Before(started) || finished.Sub(started) > collectionBudget+time.Second {
		return Workspace{}, ErrUnavailable
	}
	result := Workspace{Orders: orderReport, Refunds: refundReport, Products: productReport, CollectedFrom: started, CollectedThrough: finished}
	if !ValidWorkspace(result, e) {
		return Workspace{}, ErrUnavailable
	}
	return result, nil
}

func periodQuery(e Expectation) url.Values {
	start, _ := time.Parse(time.RFC3339, e.Start)
	// Vendor dates have whole-second precision; its default after is exclusive.
	return url.Values{"after": {start.Add(-time.Second).Format(time.RFC3339)}, "before": {e.End}, "dates_are_gmt": {"true"}, "dp": {"6"}, "orderby": {"id"}, "order": {"asc"}, "per_page": {"100"}}
}

func (a *Adapter) request(ctx context.Context, authorization, path string, query url.Values, fence func(context.Context) bool) (providerhttp.PageResult, error) {
	if ctx.Err() != nil || fence != nil && !fence(ctx) || ctx.Err() != nil {
		return providerhttp.PageResult{}, ErrUnavailable
	}
	result, err := a.client.DoPage(ctx, path, query, authorization)
	if err != nil || ctx.Err() != nil {
		clear(result.Body)
		return providerhttp.PageResult{}, ErrUnavailable
	}
	return result, nil
}

func (a *Adapter) collect(ctx context.Context, authorization, path string, query url.Values, fence func(context.Context) bool) ([]Page, error) {
	pages := make([]Page, 0, 5)
	complete := false
	defer func() {
		if !complete {
			clearPages(pages)
		}
	}()
	wanted := 1
	for number := 1; number <= wanted; number++ {
		query.Set("page", strconv.Itoa(number))
		result, err := a.request(ctx, authorization, path, query, fence)
		if err != nil {
			return nil, ErrUnavailable
		}
		total, totalErr := strconv.Atoi(result.Total)
		countPages, pagesErr := strconv.Atoi(result.TotalPages)
		if !count.MatchString(result.Total) || !count.MatchString(result.TotalPages) || totalErr != nil || pagesErr != nil || total > 500 || countPages > 5 || countPages != (total+99)/100 || len(result.Body) > 64*1024 {
			clear(result.Body)
			return nil, ErrUnavailable
		}
		if number == 1 {
			wanted = max(1, countPages)
		} else if result.Total != pages[0].Total || result.TotalPages != pages[0].TotalPages {
			clear(result.Body)
			return nil, ErrUnavailable
		}
		pages = append(pages, Page{Number: number, Total: result.Total, TotalPages: result.TotalPages, Body: result.Body})
	}
	complete = true
	return pages, nil
}

func refundParentIDs(e Expectation, pages []Page) ([]string, bool) {
	rows, valid := completeRows(e, pages)
	if !valid {
		return nil, false
	}
	seen := map[string]bool{}
	for _, raw := range rows {
		fields, valid := jsonvalue.Object(raw, "id", "parent_id", "date_created_gmt", "amount")
		if !valid || len(fields) != 4 {
			return nil, false
		}
		parent, _, valid := integerID(fields["parent_id"])
		if !valid {
			return nil, false
		}
		seen[parent] = true
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return numericIDLess(ids[i], ids[j]) })
	return ids, true
}

func (a *Adapter) parents(ctx context.Context, authorization, currency string, ids []string, fence func(context.Context) bool) ([]Parent, error) {
	parents := make([]Parent, 0, len(ids))
	for offset := 0; offset < len(ids); offset += 50 {
		batch := ids[offset:min(offset+50, len(ids))]
		query := url.Values{"include": {strings.Join(batch, ",")}, "_fields": {"id,currency"}, "orderby": {"id"}, "order": {"asc"}, "per_page": {"50"}, "page": {"1"}}
		result, err := a.request(ctx, authorization, ordersPath, query, fence)
		if err != nil {
			return nil, ErrUnavailable
		}
		if result.Total != strconv.Itoa(len(batch)) || result.TotalPages != "1" || len(result.Body) > 64*1024 {
			clear(result.Body)
			return nil, ErrUnavailable
		}
		rows, valid := array(result.Body)
		if !valid || len(rows) != len(batch) {
			clear(result.Body)
			return nil, ErrUnavailable
		}
		for i, raw := range rows {
			fields, valid := jsonvalue.Object(raw, "id", "currency")
			if !valid || len(fields) != 2 {
				clear(result.Body)
				return nil, ErrUnavailable
			}
			id, _, valid := integerID(fields["id"])
			selected, currencyOK := text(fields["currency"])
			if !valid || id != batch[i] || !currencyOK || selected != currency {
				clear(result.Body)
				return nil, ErrUnavailable
			}
			parents = append(parents, Parent{ID: id, Currency: selected})
		}
		clear(result.Body)
	}
	return parents, nil
}

func (a *Adapter) unchanged(ctx context.Context, authorization, path string, query url.Values, first Page, fence func(context.Context) bool) bool {
	query.Set("page", "1")
	result, err := a.request(ctx, authorization, path, query, fence)
	defer clear(result.Body)
	return err == nil && result.Total == first.Total && result.TotalPages == first.TotalPages && bytes.Equal(result.Body, first.Body)
}

func clearPages(pages []Page) {
	for _, page := range pages {
		clear(page.Body)
	}
}
