package main

import (
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// handleListModels — тот же принцип прокси, что у /chat/completions (GET,
// ключом текущего пользователя), чтобы клиенты могли сами подтягивать
// актуальный список моделей (с ценами и флагом is_old_model) вместо хардкода.
func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	email := currentEmail(r)

	var encKey, nonce []byte
	err := s.pool.QueryRow(r.Context(),
		`SELECT api_key_enc, api_key_nonce FROM user_llm_keys WHERE email = $1`,
		email).Scan(&encKey, &nonce)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "llm key not configured"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	apiKey, err := decryptAPIKey(encKey, nonce)
	if err != nil {
		log.Printf("list models: decrypt failed for user (email omitted): %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.modelsURL, nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("list models: upstream request failed: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "upstream request failed"})
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "upstream read failed"})
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}
