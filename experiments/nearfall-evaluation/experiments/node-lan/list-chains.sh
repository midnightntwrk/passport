#!/usr/bin/env bash

source lib.sh

for port in $NODE_PORTS
do
  listChain $port > $port.chain
done
