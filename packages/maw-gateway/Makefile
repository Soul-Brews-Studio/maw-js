CARGO ?= cargo
TARGET ?= target/release/maw-gateway
SMOKE_PORT ?= 3456
UNAME_S := $(shell uname -s)

.PHONY: build release sign test smoke clean

build: release sign

release:
	$(CARGO) build --release

sign:
ifeq ($(UNAME_S),Darwin)
	codesign -s - "$(TARGET)"
else
	@echo "codesign skipped: $(UNAME_S) is not Darwin"
endif

test:
	$(CARGO) test

smoke: build
	@set -e; \
	log="$$(mktemp)"; \
	"$(TARGET)" serve --port "$(SMOKE_PORT)" >"$$log" 2>&1 & \
	pid="$$!"; \
	trap 'kill "$$pid" >/dev/null 2>&1 || true; rm -f "$$log"' EXIT; \
	for _ in 1 2 3 4 5 6 7 8 9 10; do \
		if grep -q "listening on :$(SMOKE_PORT)" "$$log"; then break; fi; \
		sleep 0.2; \
	done; \
	grep -q "listening on :$(SMOKE_PORT)" "$$log"; \
	curl -fsS "http://127.0.0.1:$(SMOKE_PORT)/api/health" >/dev/null; \
	kill "$$pid" >/dev/null 2>&1 || true; \
	wait "$$pid" >/dev/null 2>&1 || true; \
	rm -f "$$log"; \
	trap - EXIT

clean:
	$(CARGO) clean
