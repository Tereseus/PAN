# Builds libpanmt.so for the phone and copies it into the app. The sources are not in this repo:
#
#   git clone --depth 1 --branch v4.8.5 --recurse-submodules --shallow-submodules https://github.com/OpenNMT/CTranslate2.git CT2
#   git clone --depth 1 --branch v0.2.2 https://github.com/google/sentencepiece.git SP
#
#   .\build.ps1 -Src C:\path\to\those [-Jobs 4]
#
# Two changes to those sources first, because Android has no pthread_setaffinity_np and Windows
# would not make SentencePiece's symlink:
#   CT2/src/thread_pool.cc: add  || defined(__ANDROID__)  to the #if in set_thread_affinity
#   SP/third_party: copy abseil-cpp/absl to absl, after the first configure has fetched it
#
# MinGW Makefiles and the make the NDK ships, not Ninja, and a PATH with Git Bash's folders taken
# out: this machine's cmd AutoRun breaks Ninja's link step, and make must not find sh.
param([string]$Src = "$env:TEMP\ct2", [int]$Jobs = 4)
$ErrorActionPreference = 'Stop'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ndk = "$sdk\ndk\27.0.12077973"
$cmake = "$sdk\cmake\3.31.6\bin\cmake.exe"
$make = "$ndk\prebuilt\windows-x86_64\bin\make.exe"
$build = "$Src\build"
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'Git\\(usr|bin|mingw)' }) -join ';'

& $cmake -G 'MinGW Makefiles' -S $PSScriptRoot -B $build `
  "-DCMAKE_TOOLCHAIN_FILE=$($ndk -replace '\\','/')/build/cmake/android.toolchain.cmake" `
  "-DCMAKE_MAKE_PROGRAM=$($make -replace '\\','/')" `
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-31 -DANDROID_STL=c++_static `
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-fPIC -DCMAKE_C_FLAGS=-fPIC `
  "-DCT2_DIR=$($Src -replace '\\','/')/CT2" "-DSP_DIR=$($Src -replace '\\','/')/SP"
if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
& $cmake --build $build --target panmt -j $Jobs
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$out = Join-Path $PSScriptRoot '..\app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Force $out | Out-Null
$strip = "$ndk\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe"
& $strip --strip-unneeded "$build\libpanmt.so" -o "$out\libpanmt.so"
"libpanmt.so: " + [math]::Round((Get-Item "$out\libpanmt.so").Length / 1MB, 1) + " MB"
