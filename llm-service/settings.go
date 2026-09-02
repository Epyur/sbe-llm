package main

import (
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// handleGetSettings — статус, НИКОГДА не значение ключа (write-only API):
// клиент узнаёт только "настроен/не настроен", чтобы не отправлять запрос на
// completion вслепую и показать пользователю понятную подсказку.
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	email := currentEmail(r)
	var apiURL string
	err := s.pool.QueryRow(r.Context(),
		`SELECT api_url FROM user_llm_keys WHERE email = $1`, email).Scan(&apiURL)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false, "api_url_override": false})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured":       true,
		"api_url_override": apiURL != "",
	})
}

// handleSetSettings сохраняет/заменяет ключ пользователя (upsert по email из JWT —
// подделать чужой email нельзя, подпись auth-service). api_url опционален —
// пусто/не указан = использовать LLM_API_URL сервера по умолчанию.
func (s *Server) handleSetSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIKey string `json:"api_key"`
		APIURL string `json:"api_url"`
	}
	if err := decodeJSON(w, r, &req, 1<<16); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	req.APIKey = strings.TrimSpace(req.APIKey)
	req.APIURL = strings.TrimSpace(req.APIURL)
	if req.APIKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "api_key is required"})
		return
	}

	enc, nonce, err := encryptAPIKey(req.APIKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "encryption failed"})
		return
	}

	email := currentEmail(r)
	if _, err := s.pool.Exec(r.Context(), `
INSERT INTO user_llm_keys (email, api_key_enc, api_key_nonce, api_url)
VALUES ($1, $2, $3, $4)
ON CONFLICT (email) DO UPDATE SET
	api_key_enc = EXCLUDED.api_key_enc,
	api_key_nonce = EXCLUDED.api_key_nonce,
	api_url = EXCLUDED.api_url,
	updated_at = now()`, email, enc, nonce, req.APIURL); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteSettings(w http.ResponseWriter, r *http.Request) {
	email := currentEmail(r)
	if _, err := s.pool.Exec(r.Context(),
		`DELETE FROM user_llm_keys WHERE email = $1`, email); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
