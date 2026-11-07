// The phone's translator: one small quickmt model per direction, run by CTranslate2 (MIT) with
// SentencePiece (Apache 2.0) splitting the words. Kotlin side: dev.pan.app.translate.QuickMt.
//
// Text goes both ways as UTF-8 bytes. NewStringUTF wants modified UTF-8, which is not the same
// thing once a line holds a character outside the basic plane.
#include <android/log.h>
#include <jni.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include <ctranslate2/translator.h>
#include <sentencepiece_processor.h>

namespace {

constexpr const char* TAG = "PanMt";

struct Engine {
  std::unique_ptr<ctranslate2::Translator> translator;
  sentencepiece::SentencePieceProcessor source;
  sentencepiece::SentencePieceProcessor target;
};

std::string to_string(JNIEnv* env, jbyteArray bytes) {
  const jsize n = env->GetArrayLength(bytes);
  std::string out(static_cast<size_t>(n), '\0');
  env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte*>(out.data()));
  return out;
}

jbyteArray to_bytes(JNIEnv* env, const std::string& s) {
  jbyteArray out = env->NewByteArray(static_cast<jsize>(s.size()));
  if (out != nullptr)
    env->SetByteArrayRegion(out, 0, static_cast<jsize>(s.size()), reinterpret_cast<const jbyte*>(s.data()));
  return out;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_dev_pan_app_translate_QuickMt_nativeLoad(JNIEnv* env, jclass, jbyteArray dir, jint threads) {
  const std::string path = to_string(env, dir);
  try {
    auto engine = std::make_unique<Engine>();
    if (!engine->source.Load(path + "/src.spm.model").ok() ||
        !engine->target.Load(path + "/tgt.spm.model").ok()) {
      __android_log_print(ANDROID_LOG_ERROR, TAG, "no tokenizer in %s", path.c_str());
      return 0;
    }
    ctranslate2::models::ModelLoader loader(path);
    loader.device = ctranslate2::Device::CPU;
    loader.compute_type = ctranslate2::ComputeType::INT8;
    ctranslate2::ReplicaPoolConfig config;
    config.num_threads_per_replica = static_cast<size_t>(threads);
    engine->translator = std::make_unique<ctranslate2::Translator>(loader, config);
    return reinterpret_cast<jlong>(engine.release());
  } catch (const std::exception& e) {
    __android_log_print(ANDROID_LOG_ERROR, TAG, "load %s: %s", path.c_str(), e.what());
    return 0;
  }
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_pan_app_translate_QuickMt_nativeTranslate(JNIEnv* env, jclass, jlong handle, jbyteArray text, jint beam) {
  auto* engine = reinterpret_cast<Engine*>(handle);
  try {
    std::vector<std::string> tokens;
    engine->source.Encode(to_string(env, text), &tokens);
    ctranslate2::TranslationOptions options;
    options.beam_size = static_cast<size_t>(beam);
    options.disable_unk = true;
    options.max_decoding_length = std::min<size_t>(256, tokens.size() * 2 + 10);
    const auto results = engine->translator->translate_batch({tokens}, options);
    std::string out;
    engine->target.Decode(results[0].output(), &out);
    return to_bytes(env, out);
  } catch (const std::exception& e) {
    __android_log_print(ANDROID_LOG_ERROR, TAG, "translate: %s", e.what());
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_dev_pan_app_translate_QuickMt_nativeRelease(JNIEnv*, jclass, jlong handle) {
  delete reinterpret_cast<Engine*>(handle);
}
