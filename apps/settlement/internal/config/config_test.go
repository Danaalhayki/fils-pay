package config

import "testing"

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoad_DatabaseURLRequired(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": ""})
	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_URL is unset")
	}
}

func TestLoad_RejectsUnusableDaemonSettings(t *testing.T) {
	for _, kv := range []map[string]string{
		{"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "0"},
		{"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "-5"},
		{"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "-1"},
		{"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "1440"},
		{"SETTLEMENT_PG_POOL_MAX_CONNS": "0"},
	} {
		kv["DATABASE_URL"] = "postgres://a/db"
		withEnv(t, kv)
		if _, err := Load(); err == nil {
			t.Errorf("Load() with %v succeeded, want an error", kv)
		}
		for k := range kv {
			t.Setenv(k, "")
		}
	}
}

func TestLoad_UsesDatabaseURLByDefault(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": "postgres://a/db", "PGCONN_SETTLEMENT": ""})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://a/db" {
		t.Fatalf("expected DatabaseURL to be DATABASE_URL's value, got %q", cfg.DatabaseURL)
	}
}

// FH: came in with 'test: config' (b64cd3c). it locks in the override, doesn't say the override is right
// MK: it's right.
func TestLoad_PgconnSettlementOverridesWhenSet(t *testing.T) {
	withEnv(t, map[string]string{
		"DATABASE_URL":      "postgres://a/db",
		"PGCONN_SETTLEMENT": "postgres://b/settlement-replica",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://b/settlement-replica" {
		t.Fatalf("expected the PGCONN_SETTLEMENT override to win, got %q", cfg.DatabaseURL)
	}
}
