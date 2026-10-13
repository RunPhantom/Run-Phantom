#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = --show-toplevel ]; then
    /usr/bin/git "$@"
    result=$?
    : > held
    while [ ! -f release ]; do /bin/sleep 0.01; done
    exit "$result"
  fi
done
exec /usr/bin/git "$@"
