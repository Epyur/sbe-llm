package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	pool        *pgxpool.Pool
	providerURL string
	modelsURL   string
	chatLim     *emailLimiter
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	if err := loadJWTSecret(); err != nil {
		log.Fatalf("JWT: %v", err)
	}
	if err := loadEncryptionKey(); err != nil {
		log.Fatalf("encryption key: %v", err)
	}

	providerURL := os.Getenv("LLM_API_URL")
	if providerURL == "" {
		providerURL = "https://ask.chadgpt.ru/api/v1/chat/completions"
	}
	// Отдельный env, а не вывод из providerURL заменой суффикса "/chat/completions"
	// на "/models" — providerURL может быть переопределён на нестандартный шлюз,
	// строковая эквилибристика там ненадёжна.
	modelsURL := os.Getenv("LLM_MODELS_URL")
	if modelsURL == "" {
		modelsURL = "https://ask.chadgpt.ru/api/v1/models"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping: %v", err)
	}

	s := &Server{
		pool:        pool,
		providerURL: providerURL,
		modelsURL:   modelsURL,
		// per-email, не per-IP: одна и та же квота у провайдера привязана к
		// пользователю независимо от того, с какого устройства/IP он звонит.
		chatLim: newEmailLimiter(time.Minute, 20),
	}

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	regCtx, regCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer regCancel()
	if err := s.registerApp(regCtx); err != nil {
		log.Printf("registerApp (non-fatal): %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/llm/health", s.handleHealth)
	mux.HandleFunc("GET /api/llm/settings", s.requireAuth(s.handleGetSettings))
	mux.HandleFunc("POST /api/llm/settings", s.requireAuth(s.handleSetSettings))
	mux.HandleFunc("DELETE /api/llm/settings", s.requireAuth(s.handleDeleteSettings))
	mux.HandleFunc("POST /api/llm/chat/completions", s.requireAuth(s.handleChatCompletions))
	mux.HandleFunc("GET /api/llm/models", s.requireAuth(s.handleListModels))

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// Провайдер может отвечать долго (vision/большие промпты) — таймаут
		// проксирующего запроса задаётся отдельно в proxy.go, здесь запас сверху.
		WriteTimeout: 200 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("llm-service listening on :%s (provider=%s)", port, providerURL)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

func (s *Server) migrate(ctx context.Context) error {
	stmts := []string{
		// api_key_enc/api_key_nonce — AES-256-GCM (см. crypto.go), НЕ хеш: сервису
		// нужно позже подставить реальный ключ в запрос к провайдеру, поэтому
		// операция обязана быть обратимой. api_url — пусто = использовать
		// LLM_API_URL по умолчанию (общий для всех, если явно не переопределён).
		`CREATE TABLE IF NOT EXISTS user_llm_keys (
			email         TEXT PRIMARY KEY,
			api_key_enc   BYTEA NOT NULL,
			api_key_nonce BYTEA NOT NULL,
			api_url       TEXT NOT NULL DEFAULT '',
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
	}
	for _, stmt := range stmts {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.pool.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "error", "db": "unreachable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "db": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

// decodeJSON читает JSON-тело с жёстким лимитом размера (защита от DoS памятью).
func decodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	return json.NewDecoder(r.Body).Decode(v)
}
