package main

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

const maxChatBody = 20 << 20 // 20 МБ — с запасом на vision-запросы с data URL изображения

// handleChatCompletions — тонкий reverse-proxy к провайдеру: тело запроса
// пересылается КАК ЕСТЬ (клиент — sbe-llm плагин/веб-портал — уже собирает
// {model?, messages, temperature} ровно в формате провайдера), меняется только
// Authorization — вместо JWT сервиса подставляется расшифрованный персональный
// ключ пользователя. Вся ретрай/таймаут-логика остаётся на стороне клиента
// (см. llm-center.ts) — сервер не решает за клиента, сколько раз повторять.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	email := currentEmail(r)
	if !s.chatLim.allow(email) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too many requests, try later"})
		return
	}

	var encKey, nonce []byte
	var apiURLOverride string
	err := s.pool.QueryRow(r.Context(),
		`SELECT api_key_enc, api_key_nonce, api_url FROM user_llm_keys WHERE email = $1`,
		email).Scan(&encKey, &nonce, &apiURLOverride)
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
		log.Printf("chat completions: decrypt failed for user (email omitted): %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxChatBody))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}

	targetURL := s.providerURL
	if apiURLOverride != "" {
		targetURL = apiURLOverride
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	// Таймаут прокси-запроса — с запасом под vision/большие промпты; клиент
	// (llm-center.ts) уже сам ждёт до 180с и делает retry поверх этого.
	client := &http.Client{Timeout: 190 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("chat completions: upstream request failed: %v", err)
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
