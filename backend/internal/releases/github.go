package releases

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// Publication completion is a separate observation from image creation time.
// Only the successful, main-branch publication job from the existing workflow
// qualifies. No GitHub Release or Deployment object is fabricated.
func (c remote) publicationTime(ctx context.Context, revision string) *string {
	var runs struct {
		Runs []struct {
			ID         int64  `json:"id"`
			HeadSHA    string `json:"head_sha"`
			HeadBranch string `json:"head_branch"`
			Path       string `json:"path"`
			Event      string `json:"event"`
			Conclusion string `json:"conclusion"`
		} `json:"workflow_runs"`
	}
	if c.github(ctx, "/repos/"+c.config.repository+"/actions/workflows/ci.yml/runs?head_sha="+revision+"&status=success&per_page=10", &runs) != "" || len(runs.Runs) > 10 {
		return nil
	}
	for _, run := range runs.Runs {
		if run.ID <= 0 || run.HeadSHA != revision || run.HeadBranch != "main" || run.Path != ".github/workflows/ci.yml" || run.Conclusion != "success" || (run.Event != "push" && run.Event != "workflow_dispatch") {
			continue
		}
		var jobs struct {
			Jobs []struct {
				Name        string `json:"name"`
				Conclusion  string `json:"conclusion"`
				CompletedAt string `json:"completed_at"`
			} `json:"jobs"`
		}
		if c.github(ctx, fmt.Sprintf("/repos/%s/actions/runs/%d/jobs?per_page=100", c.config.repository, run.ID), &jobs) != "" || len(jobs.Jobs) > 100 {
			return nil
		}
		for _, job := range jobs.Jobs {
			if job.Name == "Publish tested main application image" && job.Conclusion == "success" {
				stamp := cleanTimestamp(job.CompletedAt)
				if stamp != "" {
					return &stamp
				}
			}
		}
	}
	return nil
}

func (c remote) attestation(ctx context.Context, artifact Artifact) *Attestation {
	var response struct {
		Attestations []struct {
			Bundle struct {
				Envelope struct {
					Payload     string `json:"payload"`
					PayloadType string `json:"payloadType"`
				} `json:"dsseEnvelope"`
			} `json:"bundle"`
		} `json:"attestations"`
	}
	if why := c.github(ctx, "/repos/"+c.config.repository+"/attestations/"+artifact.Digest+"?per_page=10", &response); why != "" {
		return &Attestation{Status: "unavailable", Reason: why}
	}
	if len(response.Attestations) == 0 {
		return &Attestation{Status: "unavailable", Reason: "not_found"}
	}
	if len(response.Attestations) > 10 {
		return &Attestation{Status: "unavailable", Reason: "invalid_evidence"}
	}
	for _, item := range response.Attestations {
		envelope := item.Bundle.Envelope
		if envelope.PayloadType != "application/vnd.in-toto+json" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(envelope.Payload)
		if err != nil || len(data) > bodyLimit {
			continue
		}
		var statement struct {
			Type    string `json:"_type"`
			Subject []struct {
				Name   string            `json:"name"`
				Digest map[string]string `json:"digest"`
			} `json:"subject"`
			PredicateType string `json:"predicateType"`
		}
		if json.Unmarshal(data, &statement) != nil || statement.Type != "https://in-toto.io/Statement/v1" || statement.PredicateType != "https://slsa.dev/provenance/v1" || len(statement.Subject) > 20 {
			continue
		}
		for _, subject := range statement.Subject {
			if subject.Name == "ghcr.io/"+c.config.repository && "sha256:"+subject.Digest["sha256"] == artifact.Digest {
				// API retrieval and subject matching are NOT signature validation.
				return &Attestation{Status: "present", Reason: "signature_not_verified"}
			}
		}
	}
	return &Attestation{Status: "unavailable", Reason: "invalid_evidence"}
}
