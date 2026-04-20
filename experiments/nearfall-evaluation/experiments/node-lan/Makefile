#!/usr/bin/env nix-shell
#!nix-shell -i "make -f" -p gnumake


SHELL=bash

MIDNIGHT_NODE=../../../midnight-node/target/release/midnight-node

SEQUENCE:=$(shell seq 1 7)
AUTHORITIES=$(patsubst %,node-%/authority.json,$(SEQUENCE))
INITIAL_VALIDATORS=$(patsubst %,node-%/initialValidator.json,$(SEQUENCE))
INITIAL_AUTHORITIES=$(patsubst %,node-%/initialAuthority.json,$(SEQUENCE))


chain-spec-raw.json: chain-spec.json
	$(MIDNIGHT_NODE) build-spec --raw --chain $< > $@

authorities.json: $(AUTHORITIES)
	jq -s '.' $^ > $@

initialValidators.json: $(INITIAL_VALIDATORS)
	jq -s '.' $^ > $@

initialAuthorities.json: $(INITIAL_AUTHORITIES)
	jq -s '.' $^ > $@


node-%.log: node-%/identity node-%/aura.seed node-%/grandpa.seed node-%/beefy.seed
	./run-node.sh $(patsubst node-%.log,%,$@) |& tee $@

node-%/identity:
	CFG_PRESET=dev $(MIDNIGHT_NODE) key generate-node-key --file $(dir $@)/key 2> $(dir $@)/identity

node-%/authority.json: node-%/beefy.keygen
	./make-authority.sh $(patsubst node-%/authority.json,%,$@)

node-%/initialAuthority.json: node-%/identity node-%/aura.keygen node-%/grandpa.keygen
	./make-initialAuthority.sh $(patsubst node-%/initialAuthority.json,%,$@)
	
node-%/initialValidator.json: node-%/account.keygen node-%/aura.keygen node-%/grandpa.keygen
	./make-initialValidator.sh $(patsubst node-%/initialValidator.json,%,$@)
	
node-%/account.keygen:
	$(MIDNIGHT_NODE) key generate --scheme Sr25519 > $@

node-%/aura.seed: node-%/aura.keygen
	sed -n '/Secret seed/{s/^  Secret seed:       \(.*\)$$/\1/;p}' $< > $@

node-%/aura.keygen:
	$(MIDNIGHT_NODE) key generate --scheme Sr25519 > $@

node-%/beefy.seed: node-%/beefy.keygen
	sed -n '/Secret seed/{s/^  Secret seed:       \(.*\)$$/\1/;p}' $< > $@

node-%/beefy.keygen:
	$(MIDNIGHT_NODE) key generate --scheme Ecdsa > $@

node-%/grandpa.seed: node-%/grandpa.keygen
	sed -n '/Secret seed/{s/^  Secret seed:       \(.*\)$$/\1/;p}' $< > $@

node-%/grandpa.keygen:
	$(MIDNIGHT_NODE) key generate --scheme Ed25519 > $@


clear-logs:
	rm node-?.log

clear-state:
	rm -rf node-?/state/* index/*

check-sync:
	./check-sync.sh

count-peers:
	./check-sync.sh 2>/dev/null | jq '.system_health | map_values(.peers)' | json2yaml

get-finalized:
	./check-sync.sh 2>/dev/null | jq '.chain_getHeader | map_values(.parentHash)' | json2yaml
	./check-sync.sh 2>/dev/null | jq '.chain_getFinalizedHead' | json2yaml
	./check-sync.sh 2>/dev/null | jq '.beefy_getFinalizedHead' | json2yaml

list-chains:
	./list-chains.sh

rpc_methods.yaml:
	curl -sS -H "Content-Type: application/json" -X POST -d '{"jsonrpc":"2.0","id":1,"method":"rpc_methods","params":[]}' http://127.0.0.1:9944 | json2yaml > $@


.PRECIOUS: node-% node-%/key node-%/identity node-%/account.keygen node-%/account.seed node-%/aura.keygen node-%/aura.seed node-%/beefy.keygen node-%/beefy.seed node-%/grandpa.keygen node-%/grandpa.seed

.PHONY: check-sync list-chains clear-state clear-logs

.SUFFIXES:

