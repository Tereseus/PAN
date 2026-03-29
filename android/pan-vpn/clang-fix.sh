#!/bin/bash
# Wrapper for NDK clang that fixes Go 1.26 CGo bug
# Go 1.26 passes CGo source filenames without paths to clang
# This wrapper prepends the Go cgo source directory if the file isn't found

REAL_CLANG="C:/Users/tzuri/AppData/Local/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android26-clang.cmd"
CGO_SRC="/c/Program Files/Go/src/runtime/cgo"

args=()
for arg in "$@"; do
    if [[ "$arg" == *.c || "$arg" == *.S ]] && [[ ! -f "$arg" ]] && [[ -f "$CGO_SRC/$arg" ]]; then
        args+=("$CGO_SRC/$arg")
    else
        args+=("$arg")
    fi
done

exec "$REAL_CLANG" "${args[@]}"
