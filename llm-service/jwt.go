package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret []byte

// loadJWTSecret — per-service ключ (тот же паттерн, что у остальных SBE-сервисов):
// вместо общего JWT_SECRET валидируем токены своим {APP}_SERVICE_SECRET.
func loadJWTSecret() error {
	key := strings.ToUpper(appIDFromEnv()) + "_SERVICE_SECRET"
	secret := os.Getenv(key)
	if secret == "" {
		return fmt.Errorf("%s is required", key)
	}
	jwtSecret = []byte(secret)
	return nil
}

type jwtClaims struct {
	Email    string `json:"email"`
	DeviceID string `json:"device_id"`
	AppID    string `json:"app_id"`
	Channel  string `json:"channel"`
	jwt.RegisteredClaims
}

func parseJWT(tokenStr string) (*jwtClaims, error) {
	claims, err := parseWithKey(tokenStr, jwtSecret)
	if err != nil {
		if legacy := os.Getenv("JWT_SECRET"); legacy != "" {
			if c, e2 := parseWithKey(tokenStr, []byte(legacy)); e2 == nil {
				return c, nil
			}
		}
	}
	return claims, err
}

func parseWithKey(tokenStr string, key []byte) (*jwtClaims, error) {
	claims := &jwtClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return key, nil
	}, jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func claimStringsContains(a jwt.ClaimStrings, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}

func appIDFromEnv() string {
	if v := os.Getenv("LLM_APP_ID"); v != "" {
		return v
	}
	return "llm"
}

type permEmailCtx struct{}

// requireAuth — llm-service не знает ролей (нет {app}_permissions): каждый
// авторизованный пользователь управляет ТОЛЬКО своим собственным ключом
// (email из подписанного JWT, подделать нельзя), поэтому разграничивать
// уровни доступа нечем — достаточно валидного токена для app_id=llm.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		tokenStr := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
		if tokenStr == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		claims, err := parseJWT(tokenStr)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		if claims.AppID != appIDFromEnv() {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
			return
		}
		if claims.Issuer != "" && claims.Issuer != "auth-service" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		if len(claims.Audience) > 0 && !claimStringsContains(claims.Audience, appIDFromEnv()) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		ctx := context.WithValue(r.Context(), permEmailCtx{}, claims.Email)
		next(w, r.WithContext(ctx))
	}
}

func currentEmail(r *http.Request) string {
	if v, ok := r.Context().Value(permEmailCtx{}).(string); ok {
		return v
	}
	return ""
}
