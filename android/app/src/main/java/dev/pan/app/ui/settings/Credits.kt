package dev.pan.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Everyone whose work PAN runs on, with the licence it comes under. Several of these licences make
 * the credit a condition, so this list is part of the product: it follows the "What runs today"
 * table in docs/MODEL-CREDITS.md and changes in the same commit as that table.
 */
private data class Credit(val name: String, val does: String, val by: String, val licence: String, val note: String = "")

private val ON_THE_COMPUTER = listOf(
    Credit("Syrinx", "ΠAN's own voice model", "built on Liquid AI's LFM2", "LFM Open License v1.0",
        "Its sound tokenizer is Kyutai's Mimi (CC BY 4.0)."),
    Credit("Phi-4-mini", "answers what the voice model hands up", "Microsoft", "MIT"),
    Credit("Gemma 4", "long prompts, pictures, background jobs", "Google", "Apache 2.0"),
    Credit("Qwen3-Embedding 0.6B", "memory search", "Alibaba", "Apache 2.0"),
    Credit("Parakeet TDT 0.6B v2 and v3", "turns speech into text", "NVIDIA", "CC BY 4.0",
        "Used as converted (int8 ONNX) files. creativecommons.org/licenses/by/4.0"),
    Credit("SenseVoice Small", "hears Japanese, Chinese, Korean, Cantonese and English", "Alibaba Group (FunAudioLLM)", "FunASR Model License 1.1"),
    Credit("3D-Speaker CAM++", "tells voices apart", "Alibaba", "Apache 2.0"),
    Credit("MADLAD-400", "translation", "Google", "Apache 2.0"),
    Credit("kuromoji", "splits Japanese into words with their readings", "Atilika, JavaScript port by Takuya Asano", "Apache 2.0",
        "With the IPADIC dictionary (mecab-ipadic 2.7.0), copyright 2000 to 2003 Nara Institute of Science and Technology, and ICOT. Its full notice ships with ΠAN on the computer."),
    Credit("JMdict", "what each Japanese word means", "Electronic Dictionary Research and Development Group", "CC BY-SA 4.0",
        "The word meanings come from the JMdict dictionary file, the property of the Electronic Dictionary Research and Development Group, " +
            "used in conformance with the Group's licence: www.edrdg.org/edrdg/licence.html. Read through the jmdict-simplified project (scriptin on GitHub). " +
            "The meanings file stays under the same licence."),
    Credit("Ollama, ONNX Runtime", "run the models", "Ollama; Microsoft", "MIT"),
    Credit("SQLCipher, sqlite-vec", "storage", "Zetetic; Alex Garcia", "BSD style; MIT or Apache 2.0"),
)

private val ON_THIS_DEVICE = listOf(
    Credit("Supertonic 3", "ΠAN's voice", "Supertone", "OpenRAIL-M (model), MIT (code)",
        "ΠAN's voice is machine made. It must not be used to pass as a real person without their consent."),
    Credit("Streaming zipformer", "live words as you speak", "k2-fsa (Next-gen Kaldi)", "Apache 2.0"),
    Credit("Material Symbols", "the microphone, crossed microphone and ear on the mic button", "Google", "Apache 2.0"),
    Credit("Smart Turn v3", "knows when you have finished", "Pipecat", "BSD 2-Clause"),
    Credit("Silero VAD", "knows when someone is talking", "Silero Team", "MIT"),
    Credit("YAMNet", "knows when music is playing", "Google", "Apache 2.0"),
    Credit("quickmt", "translation on the device", "quickmt", "CC BY 4.0", "creativecommons.org/licenses/by/4.0"),
    Credit("Parakeet TDT 0.6B v3, Greek", "hears Greek", "myned-ai, from NVIDIA's Parakeet TDT 0.6B v3", "CC BY 4.0"),
    Credit("SenseVoice Small", "hears Japanese, Chinese, Korean, Cantonese and English", "Alibaba Group (FunAudioLLM)", "FunASR Model License 1.1"),
    Credit("Whisper tiny", "tells which language was spoken", "OpenAI", "Apache 2.0"),
    Credit("CTranslate2, SentencePiece", "run the translators", "OpenNMT; Google", "MIT; Apache 2.0"),
    Credit("sherpa-onnx", "runs the ears and the voice", "k2-fsa", "Apache 2.0"),
    Credit("Tailscale, wireguard-go", "the private link between your devices", "Tailscale; WireGuard", "BSD 3-Clause; MIT"),
    Credit("CameraX, ZXing", "camera and pairing codes", "Google; ZXing authors", "Apache 2.0"),
)

@Composable
fun Credits() {
    var open by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 10.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Credits and licences", style = MaterialTheme.typography.bodyLarge)
                Text("The people and projects ΠAN is built on", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (open) "▴" else "▾", style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (open) {
            CreditGroup("On your computer", ON_THE_COMPUTER)
            Spacer(Modifier.height(10.dp))
            CreditGroup("On this device", ON_THIS_DEVICE)
        }
    }
}

@Composable
private fun CreditGroup(title: String, credits: List<Credit>) {
    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(bottom = 4.dp))
    credits.forEach { c ->
        Column(modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
            Text(c.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text("${c.does}. By ${c.by}. ${c.licence}.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (c.note.isNotBlank()) Text(c.note, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
