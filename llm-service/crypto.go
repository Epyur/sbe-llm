package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

// encryptionKey — 32-байтовый AES-256 ключ из LLM_KEY_ENCRYPTION_KEY (base64),
// отдельный от LLM_POSTGRES_PASSWORD/LLM_SERVICE_SECRET: дамп БД сам по себе
// ключи пользователей не раскрывает, нужен ещё и этот секрет из .env сервера.
var encryptionKey []byte

func loadEncryptionKey() error {
	raw := os.Getenv("LLM_KEY_ENCRYPTION_KEY")
	if raw == "" {
		return fmt.Errorf("LLM_KEY_ENCRYPTION_KEY is required")
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return fmt.Errorf("LLM_KEY_ENCRYPTION_KEY: invalid base64: %w", err)
	}
	if len(key) != 32 {
		return fmt.Errorf("LLM_KEY_ENCRYPTION_KEY: expected 32 bytes after base64 decode, got %d", len(key))
	}
	encryptionKey = key
	return nil
}

// encryptAPIKey шифрует ключ пользователя AES-256-GCM. Возвращает (ciphertext, nonce).
// Хеширование не подходит: сервису нужно позже ПОДСТАВИТЬ ключ провайдеру, а не
// только сверить совпадение — операция обязана быть обратимой.
func encryptAPIKey(plain string) (ciphertext, nonce []byte, err error) {
	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = gcm.Seal(nil, nonce, []byte(plain), nil)
	return ciphertext, nonce, nil
}

func decryptAPIKey(ciphertext, nonce []byte) (string, error) {
	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
