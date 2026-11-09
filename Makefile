VERSION ?= 0.4.5
.PHONY: build test release
build:
	cargo build --release --locked
	mkdir -p bin
	cp target/release/fork bin/fork

test:
	cargo test --locked

release: build
	mkdir -p dist
	cp target/release/fork dist/fork-agent-$(shell uname -s | tr A-Z a-z)-$(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
	sed 's/^version=.*/version=$${FORK_CLI_VERSION:-$(VERSION)}/' install.sh > dist/install.sh
	tar -czf dist/virtual-computer.tar.gz virtual-computer/src virtual-computer/deploy virtual-computer/package.json virtual-computer/package-lock.json virtual-computer/README.md
	cd dist && shasum -a 256 fork-agent-* virtual-computer.tar.gz > SHA256SUMS
