package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

// registerApp регистрирует сервис в auth-service (тот же паттерн, что у
// остальных SBE-сервисов) — без seedOwner: у llm-service нет модели ролей,
// каждый пользователь управляет только своим собственным ключом.
func (s *Server) registerApp(ctx context.Context) error {
	authURL := os.Getenv("AUTH_SERVICE_URL")
	if authURL == "" {
		authURL = "http://auth-service:3000"
	}
	serviceSecret := os.Getenv("LLM_SERVICE_SECRET")
	if serviceSecret == "" {
		return fmt.Errorf("LLM_SERVICE_SECRET is required for /apps/register")
	}
	name := os.Getenv("LLM_APP_NAME")
	if name == "" {
		name = "LLM Center"
	}

	body, err := json.Marshal(map[string]string{
		"app_id":         appIDFromEnv(),
		"name":           name,
		"owner_email":    os.Getenv("LLM_OWNER_EMAIL"),
		"service_secret": serviceSecret,
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+"/apps/register", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("apps/register status %d", resp.StatusCode)
	}
	log.Printf("registerApp: %s registered", appIDFromEnv())
	return nil
}
