# libpanmt.so: CTranslate2 + SentencePiece + the JNI in panmt.cpp, statically linked into one
# library. Built by build.ps1, not by Gradle: the G16's cmd AutoRun breaks Gradle's CMake + Ninja.
cmake_minimum_required(VERSION 3.15)
project(panmt C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

# CPU only, and Ruy for the int8 matrix work: the one backend with ARM kernels of its own.
set(WITH_MKL OFF CACHE BOOL "" FORCE)
set(WITH_DNNL OFF CACHE BOOL "" FORCE)
set(WITH_OPENBLAS OFF CACHE BOOL "" FORCE)
set(WITH_ACCELERATE OFF CACHE BOOL "" FORCE)
set(WITH_RUY ON CACHE BOOL "" FORCE)
set(WITH_CUDA OFF CACHE BOOL "" FORCE)
set(ENABLE_CPU_DISPATCH OFF CACHE BOOL "" FORCE)
set(BUILD_CLI OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(OPENMP_RUNTIME "NONE" CACHE STRING "" FORCE)
add_subdirectory(${CT2_DIR} ct2 EXCLUDE_FROM_ALL)

set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
set(SPM_BUILD_TEST OFF CACHE BOOL "" FORCE)
add_subdirectory(${SP_DIR} spm EXCLUDE_FROM_ALL)

add_library(panmt SHARED panmt.cpp)
target_include_directories(panmt PRIVATE ${CT2_DIR}/include ${SP_DIR} ${SP_DIR}/src ${SP_DIR}/third_party/abseil-cpp ${SP_DIR}/third_party/protobuf-lite)
target_link_libraries(panmt PRIVATE ctranslate2 sentencepiece-static log)
target_link_options(panmt PRIVATE -Wl,--gc-sections -Wl,-z,max-page-size=16384 -Wl,--exclude-libs,ALL)
