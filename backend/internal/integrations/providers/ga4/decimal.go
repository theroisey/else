package ga4

import (
	"regexp"
	"strconv"
	"strings"
)

var decimalMantissa = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$`)
var decimalExponent = regexp.MustCompile(`^[+-]?[0-9]{1,2}$`)

// ExactDecimal accepts a bounded nonnegative provider number, including ordinary
// scientific notation. The output is canonical decimal text, never float64.
// Bounds support observed counts/attribution credits without unbounded powers.
func exactDecimal(raw string) (string, bool) {
	if len(raw) == 0 || len(raw) > 64 {
		return "", false
	}
	parts := strings.FieldsFunc(raw, func(c rune) bool { return c == 'e' || c == 'E' })
	if len(parts) < 1 || len(parts) > 2 {
		return "", false
	}
	mantissa := parts[0]
	exponent := 0
	if len(parts) == 2 {
		if !decimalExponent.MatchString(parts[1]) {
			return "", false
		}
		var err error
		exponent, err = strconv.Atoi(parts[1])
		if err != nil || exponent < -18 || exponent > 18 {
			return "", false
		}
		if raw != mantissa+"e"+parts[1] && raw != mantissa+"E"+parts[1] {
			return "", false
		}
	} else if raw != mantissa {
		return "", false
	}
	if !decimalMantissa.MatchString(mantissa) {
		return "", false
	}
	fraction := 0
	if index := strings.IndexByte(mantissa, '.'); index >= 0 {
		fraction = len(mantissa) - index - 1
		mantissa = mantissa[:index] + mantissa[index+1:]
	}
	scale := fraction - exponent
	if scale < 0 {
		mantissa += strings.Repeat("0", -scale)
		scale = 0
	}
	if len(mantissa) <= scale {
		mantissa = strings.Repeat("0", scale-len(mantissa)+1) + mantissa
	}
	whole, decimal := mantissa[:len(mantissa)-scale], mantissa[len(mantissa)-scale:]
	whole = strings.TrimLeft(whole, "0")
	if whole == "" {
		whole = "0"
	}
	decimal = strings.TrimRight(decimal, "0")
	if len(whole) > 18 || len(decimal) > 18 {
		return "", false
	}
	if decimal != "" {
		return whole + "." + decimal, true
	}
	return whole, true
}

func validMetricHeaders(raw []byte, metrics []Metric) bool {
	headers, ok := array(raw, false)
	if !ok || len(headers) != len(metrics) {
		return false
	}
	for i, raw := range headers {
		fields, ok := object(raw, "name", "type")
		if !ok || len(fields) != 2 || !exactString(fields["name"], metrics[i].Name) || !exactString(fields["type"], metrics[i].Type) {
			return false
		}
	}
	return true
}
func metricValues(raw []byte, metrics []Metric) ([]string, bool) {
	items, ok := array(raw, false)
	if !ok || len(items) != len(metrics) {
		return nil, false
	}
	values := make([]string, len(items))
	for i, raw := range items {
		fields, ok := object(raw, "value")
		var value string
		if !ok || len(fields) != 1 || !stringValue(fields["value"], &value) {
			return nil, false
		}
		switch metrics[i].Type {
		case "TYPE_INTEGER":
			if !integer.MatchString(value) {
				return nil, false
			}
		case "TYPE_FLOAT":
			value, ok = exactDecimal(value)
			if !ok {
				return nil, false
			}
		default:
			return nil, false
		}
		values[i] = value
	}
	return values, true
}
