# push-pan-models.ps1
# What PAN runs, where, and what limits it has: every model and service on the phone, the mini
# PC hub, Mint and the cloud, on one page. Renders service/public/pan-models.html.
# Pattern: push script + plain HTML page + dashboard registry entry (see push-pan-system.ps1).
#
# Hub and cloud rows come from the live settings API on every run, so a changed model shows up
# by itself. Phone rows are fixed by the app build: when a release changes how the phone hears,
# speaks or sees, update $PhoneRows below.
#
# PAN runs it when the page is opened and is more than 5 minutes old (server.js, just before the
# root static mount), so there is no scheduled task. To rebuild by hand on the hub:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\PAN\service\scripts\push-pan-models.ps1

param(
    # Run as another user, whose LOCALAPPDATA is not PAN's, pass PAN's own.
    [string]$ModelsDir = (Join-Path $env:LOCALAPPDATA 'PAN\models')
)

$ErrorActionPreference = 'Stop'

$OutFile  = Join-Path $PSScriptRoot '..\public\pan-models.html'
$RouterJs = Join-Path $PSScriptRoot '..\src\router.js'
$Base     = 'http://localhost:7777'
$Inv      = [Globalization.CultureInfo]::InvariantCulture

# Fixed by the app build. Update when a release changes how the phone hears, speaks or sees.
$PhoneRows = @(
    @{ Job = 'Hears you'; Kind = 'local'; Limit = 'free'
       What = 'sherpa streaming zipformer (English, 70M) with the mic always open. Smart Turn v3.2 decides when you have finished talking'
       Note = 'The hub redoes these words with Parakeet, so this text is only the fallback' },
    @{ Job = 'Speaks English'; Kind = 'local'; Limit = 'free'
       What = 'Supertonic 3 (4 steps, speed 1.20). Kokoro is installed as a backup voice' },
    @{ Job = 'Speaks other languages'; Kind = 'local'; Limit = 'free'
       What = "Android's own system voices (the Greek lady, Japanese and the rest). Interpreting uses Supertonic for all but Chinese" },
    @{ Job = 'Says what is in a photo'; Kind = 'local'; Limit = 'free, no quota'
       What = 'Gemini Nano, built into the phone. If it cannot, the photo goes to the hub'
       Note = 'Runs on the phone itself. It is not the cloud Gemini and has nothing to do with that quota' },
    @{ Job = 'Interprets Japanese and Greek'; Kind = 'local'; Limit = 'free'
       What = 'SenseVoice hears Japanese and English, a Greek Parakeet hears Greek, Whisper tiny tells English from Greek, quickmt translates, Supertonic 3 speaks on the normal audio path (Chinese stays on the Android voice)'
       Note = 'No hub and no language model once the mode is on. Models are on this phone by hand for now' },
    @{ Job = 'Thinks and answers'; Kind = ''; Limit = ''
       What = 'Nothing on the phone, apart from interpreting. Every other turn goes to the hub' }
)

$CallerWords = @{
    'router' = 'Voice and chat answers'; 'smart-steward' = 'Steward (keeps services alive)'
    'intuition-classifier' = 'Old Intuition classifier (retired Nov 3)'; 'task-reconcile' = 'Task tracking'
    'evolution-critique' = 'Self critique'; 'scout' = 'Scout (looks for new tools)'
    'consolidation' = 'Memory consolidation'; 'recall-synthesis' = 'Answers from memory'
    'dream' = 'Dream cycle'; 'conv-state' = 'Conversation state'; 'vision' = 'Camera and photos'
    'vision-answer' = 'Answers about photos'; 'tools.decide' = 'Decide tool'; 'pan-reasoning' = 'Reasoning'
    'pan-reasoning-render' = 'Reasoning, spoken version'; 'benchmark_dream_judge' = 'Benchmark judge'
}

# What each job is in a person's head, and the seconds it would have to take in a real
# conversation. 0 = background: no speed target, but it shares the CPU with a live turn.
$CallerMind = @{
    'router' = @('Talking back to you', 1); 'recall-synthesis' = @('Remembering out loud', 1)
    'conv-state' = @('Keeping track of the topic', 0.1); 'tools.decide' = @('Deciding to look something up', 0.3)
    'vision' = @('Glancing at something', 1); 'vision-answer' = @('Saying what you see', 1)
    'pan-reasoning' = @('Thinking it over', 3); 'pan-reasoning-render' = @('Putting a thought into words', 1)
    'intuition-classifier' = @('Reading the room', 0.1); 'consolidation' = @('Sleep: filing the day into memory', 0)
    'dream' = @('Dreaming', 0); 'evolution-critique' = @('Looking back on how things went', 0)
    'task-reconcile' = @('Remembering what you promised', 0); 'smart-steward' = @('Body housekeeping', 0)
    'scout' = @('Reading up on new tools', 0); 'benchmark_dream_judge' = @('Marking a test', 0)
}

# The cards below are written by hand, not read from anywhere: update them after a new voice
# bench, or when the hardware or the plan changes.
$WhereWeAre = @(
    @('warn', 'Voice: 2.5 s from when you stop to when PAN speaks, 3.6 s on slow turns (real conversation test, 52 lines, Nov 5), on the mini PC with no graphics card. Done: it answers the lines meant for it, does not start while you are still talking, stops in 0.7 s when you cut in, and remembers the whole talk. Not there yet: it still answers some lines meant for the room. Next: send the audio while you talk, hearing is the slice to go after.'),
    @('good', 'Interpreting: on the phone since Nov 5, no hub and no language model. It took 3.0 s through the hub in your live test, and 0.3 to 0.75 s on the phone with the Android voices (bench). You picked Supertonic for how it sounds on Nov 6: about 1.0 to 1.4 s, worked out from the parts, not yet measured end to end. Still to do: that measurement, an echo test on the real mic, and a live test with a real person.'),
    @('good', 'Intuition: steps 1 to 3 of 8 done, and it runs on rules with no model. Next: situations, and one rule for when PAN may speak (review item 8).'),
    @('good', 'Memory: filing fixed Nov 4. Vector search moved to its own thread and into memory on Nov 5: 0.5 s, same results. It used to take 8 to 21 s and freeze the whole hub.'),
    @('good', 'Background: the idle loops are off, and the steward only thinks when something changes.'),
    @('bad', 'The hub has no GPU. Anything that reads PAN''s full prompt takes 20 to 38 s. A GPU fixes that.')
)

# One voice turn, step by step. Now = voicebench run 20261105-184242 (real conversation, medians) and the
# interpreter run 20261104-034208.
$Stages = @(
    @('Hearing you finish', 'Knows you are finishing before you stop', '0.2 s', '0.45 s on the phone', 'Fine for now'),
    @('Turning speech into words', 'Understands while you talk', '0.1 s after you stop', '0.62 s (sent after you stop, then Parakeet), 1.2 s on lines over 8 s', 'Send the audio to the hub while you talk: the biggest slice left'),
    @('First words of the reply', 'Plans the answer while listening', '0.2 s', '0.22 s at the hub on the CPU with the voice reader, no card', 'Done'),
    @('Starting to speak', 'Instant', '0.1 s', '0.57 s (Supertonic on the phone builds the whole first clause before any sound)', 'App 0.4.73 uses 4 refinement steps: 3 lost the last word of 12% of real lines. It also cuts the 0.3 s of quiet at the start of each clip, which this number does not show'),
    @('The whole gap', '0.1 to 0.2 s; past 0.7 s it sounds like hesitation', '0.6 s, 1 s on slow turns', '2.5 s, 3.6 s on slow turns (real conversation test)', 'All of the above, overlapped'),
    @('Interpreting a line', 'A human interpreter runs 2 to 3 s behind', '0.7 s', 'About 1.0 to 1.4 s with Supertonic (worked out, not measured), 0.3 to 0.75 s with the Android voices (bench), 3.0 s through the hub (live test)', 'The voice is 0.7 s of that: it builds the whole line first. Then a live test with a real person'),
    @('Remembering', 'Under a second for what comes to mind', '1 s', '0.5 s for the search, 2.8 s for a whole turn about another day', 'Fine for now'),
    @('Looking at something', 'Knows a scene at a glance', '1 s', '3 s (moondream on the CPU)', 'A GPU')
)

# Measured where it says so; the rest are estimates. The prices below are hand checked: Skroutz
# in the browser for cards, OpenRouter's provider table for gpt-oss-120b. Check them again before
# anyone buys on them.
$Eur = [char]0x20AC
$Hardware = @(
    @('good', 'The mini PC today (Ryzen 7 5800H, no GPU)', 'Reads a prompt at about 285 tokens/s and writes 22 to 35 tokens/s (measured). Fine for hearing, the translator, Syrinx''s short replies and the rules. Anything that reads PAN''s full prompt takes 20 to 38 s.'),
    @('good', 'The RTX 3050 8 GB already in Mint', 'gemma4:e2b gave its first word in 0.2 s and wrote 76 to 95 tokens/s (measured Sep 12). Published: about 3,860 tokens/s to read a prompt, so PAN''s full prompt in about 0.7 s (PAN once measured slower there, recheck). Takes the whole gap from 2.4 s to about 1.5 s. Getting to 0.6 s also needs the voice starting faster and your audio sent while you talk. Catch: it is the game dev card.'),
    @('good', 'One new card for game dev, and the 3050 becomes PAN''s', 'Mint has 2 long slots and a 1200 W power supply, so both cards can stay in (check the fit first). Game dev gets the new card and PAN gets the 3050 all the time, with no GAME MODE swaps. The hub stays on the mini PC and sends its model calls to Mint. 8 GB holds Syrinx, memory search and the camera model. Mint has to stay on.'),
    @('good', 'A GPU laptop as the voice box', "It runs only the voice models, the hub stays on the mini PC, and it can go to Japan. Your G16 already is one: RTX 4070 8 GB and 32 GB RAM, with no power cut since Sep 2 (the failing core is still the risk). Measured on it Nov 4: Syrinx first word 0.04 s, first clause 0.18 s, whole reply 0.48 s, writing 136 tokens/s in 1.2 GB. gemma4:e2b read a 3,000 token prompt and gave its first word in 0.45 s. If it can't do the job, used on Skroutz, Nov 4: Lenovo Legion 5 with an RTX 3070 8 GB at ${Eur}740 (16 GB RAM), Lenovo LOQ with an RTX 4060 at ${Eur}800, Acer Nitro V 15 with an RTX 4060 at ${Eur}950 (32 GB). New ones start at ${Eur}1,045 with an RTX 5050. Real mini PCs with a GPU start around ${Eur}2,350 on Skroutz and `$1,759 at Minisforum."),
    @('good', 'A small box for the voice', 'Shopping list, US prices Nov 4. HP EliteDesk 800 G6 SFF renewed, i7-10700, 32 GB, about $500: SFF, never a Desktop Mini, and check it has the 250 W power supply. RTX A2000 12 GB, $497 to $690, with the low profile bracket: it needs no power cable. Mini DisplayPort to HDMI cable, $15 to $30, because the card has no HDMI. 15.6 inch portable monitor with mini HDMI and USB-C, $70 to $150. That is about $1,100 to $1,400. A 4K projector adds $700 to $1,000, and a 1080p one is too small for 4 screens. For 16 GB: RTX 2000 Ada, $849. Estimated about 0.7 s once the voice work is done, with the box in the same city. In the daytime it stays at the hotel and the phone reaches it over the tunnel.'),
    @('good', 'Training Syrinx for speed', 'It is why Syrinx answers in about 2 s where gemma4:e2b takes 25 s on the same CPU: the rules live in the model, so its prompt is short, and the model is smaller. More rounds can shorten the prompt and shrink the model, and then a cheaper card is enough. The limit: only 1.06 s of the 2.4 s is the model. Syrinx cannot go on Cerebras or Groq at normal prices. Cerebras takes your own weights only on dedicated enterprise endpoints, and Groq only takes enterprise adapters on Llama 3.1 8B.'),
    @('', 'PAN for other people', 'Most people have no graphics card: roughly 1 PC in 5 to 1 in 8 has one (secondary sources). PAN has to run on what they own, with no account to sign up for, or it is not their own AI. These numbers keep the real conversation: history, memory, time and situation are all in the prompt. With an 8 GB card: 0.65 s (estimate). With no card, measured on this mini PC''s CPU on Nov 5 through the real voice path, with up to 10 lines of history: first spoken chunk 1.17 s on Ollama, 0.30 s on the voice reader, which reads the conversation before your words arrive and is handed the fixed start of its reply. The G16''s 4070 gives 0.19 s. With the voice work the whole gap with no card comes to about 1.1 s (estimate). A phone running all of it alone is not tested: the only figures are a Samsung on a smaller model. The voice taking 0.7 s to start is now the biggest number left for everyone.')
)

# Skroutz, new cards, Nov 4: card, memory speed, cheapest, a well reviewed one, what it does for PAN.
$GpuPrices = @(
    @('RTX 3050 8 GB', '224 GB/s', "from ${Eur}340 (Palit)", "${Eur}360 (Gigabyte Windforce)", 'Measured 0.2 s to the first word. Syrinx, memory search and the camera model fit.'),
    @('RTX 3060 12 GB', '360 GB/s', "from ${Eur}470 (Biostar, one review, 1 star)", "${Eur}510 (Gigabyte Windforce, 4.9 stars)", 'Writes about 1.6 times faster than the 3050 (estimate). Adds room for the translator.'),
    @('RTX 4060 Ti 16 GB', '288 GB/s', 'Not sold new', '', "The only 4060 Ti left on Skroutz is an 8 GB at ${Eur}900. Skip it."),
    @('RTX 5060 Ti 16 GB', '448 GB/s', "from ${Eur}797 (Inno 3D)", "${Eur}848 (MSI Ventus, best seller)", "Writes about 2 times faster than the 3050 (estimate). Holds Syrinx, gemma4:e2b, the camera model and the translator together, and it is the real game dev upgrade. One used listing at ${Eur}700.")
)

# Service, dollars per 1M tokens in and out, first word, tokens/s. gpt-oss-120b rows are OpenRouter's
# live medians on Nov 4; the Syrinx and Gemini rows are PAN's own numbers.
$CloudPrices = @(
    @('Syrinx on the hub today', 0, 0, '1.06 s', '32'),
    @('Cerebras', 0.35, 0.75, '0.16 s', '824'),
    @('Groq', 0.15, 0.60, '0.17 s', '345'),
    @('Baseten', 0.10, 0.50, '0.15 s', '176'),
    @('Crusoe', 0.05, 0.25, '0.21 s', '192'),
    @('CoreWeave', 0.03, 0.17, '0.21 s', '135'),
    @('Nebius', 0.15, 0.60, '0.29 s', '319'),
    @('Together', 0.15, 0.60, '0.41 s', '54'),
    @('Amazon Bedrock', 0.15, 0.60, '0.42 s', '352'),
    @('SambaNova', 0.14, 0.95, '1.83 s', '361'),
    @('Gemini 3.5 Flash-Lite, paid', 0.30, 2.50, '2.1 s whole reply', '-'),
    @('Gemini 3.1 Flash-Lite, paid', 0.25, 1.50, '2 to 6 s whole reply', '-')
)
$TurnsNormal = 130   # router calls a day, week of Nov 4
$TurnsHeavy = 500

# Estimates from the voice bench plus the home to Tokyo round trip measured Nov 4.
$Japan = @(
    @('', 'Hub at home, as it is', 'about 3.6 s', 'Free'),
    @('', 'Hub at home with a cloud model', 'about 2.9 s', '2 to 16 dollars a month'),
    @('', 'Hub at home with a GPU', 'about 2.7 s', 'A card'),
    @('', 'Hub at home with a GPU, and audio sent while you talk', 'about 1.6 s', 'A card, plus the live connection work'),
    @('', 'Mini PC in the hotel, as it is', 'about 2.5 s', 'Free, and you carry it'),
    @('good', 'Mini PC in the hotel with a cloud model', 'about 1.8 s', '2 to 16 dollars a month, and you carry it'),
    @('good', 'GPU box in the hotel', 'about 1.6 s', 'The new box, private, and Syrinx stays'),
    @('good', 'GPU box in the hotel, with all the 0.6 s work done', 'about 0.65 s', 'The new box, plus the work in the card above')
)

# Each step's gap adds up the stage medians; estimates until each one is measured with voicebench.
$Ladder = @(
    @('Before Nov 4', '2.4 s', ''),
    @('Syrinx on a GPU (tried, on the G16)', '1.5 s', 'First words at the hub went 1.31 s to 0.16 s. But in the real conversation test the mini PC with the voice reader matched the G16 at the median (1.74 s and 1.75 s), so the G16 is out of the voice path.'),
    @('The voice on the same GPU, streamed to the phone', '0.9 s', 'Voice start 0.71 s to 0.1 s. Supertonic stays, it just moves.'),
    @('Audio sent while you talk', '0.75 s', 'Your words are ready when you stop. Needs the live connection.'),
    @('Train Syrinx to say its words first', '0.65 s', 'First clause 0.18 s to 0.1 s. Today its JSON labels come before the words. Handing it the fixed start of the reply may do this with no training (test, Nov 5).'),
    @('Tighter end of turn', '0.6 s', 'Knowing you finished 0.37 s to 0.3 s. Today no turn gets cut off, so there is room.'),
    @('Start the reply before PAN is sure you finished', '0.45 s', 'Thrown away if you keep talking.')
)

function Get-Api($url, $timeout = 6) {
    try { return Invoke-RestMethod -Uri $url -TimeoutSec $timeout -ErrorAction Stop }
    catch { return $null }
}
function E($s) { if ($null -eq $s) { return '' } [System.Net.WebUtility]::HtmlEncode([string]$s) }

$S        = Get-Api "$Base/api/v1/settings"
$routing  = Get-Api "$Base/api/v1/usage/llm-routing" 15
$apk      = Get-Api "$Base/api/v1/apk/version"
$tailnet  = Get-Api "$Base/api/v1/tailscale/peers"
$fallback = Get-Api "$Base/dashboard/api/events?type=ai_fallback_attempt&limit=100"
$xlate    = Get-Api 'http://127.0.0.1:7784/' 4

# A page built without the settings would be wrong everywhere; keep the last good one instead.
if (-not $S) { throw 'settings API did not answer; leaving the last page in place' }

function Setting($k) {
    if ($S.PSObject.Properties[$k]) { return $S.$k }
    return $null
}
function AsList($v) {
    if ($null -eq $v -or "$v" -eq '') { return ,@() }
    if ($v -is [string]) { try { $v = ConvertFrom-Json $v } catch { return ,@($v) } }
    return ,@($v)
}
function Bare($m) { ([string]$m) -replace '^ollama:', '' }
function IsCloud($m) { ([string]$m) -match '^(gemini|cerebras|groq|openai|anthropic|claude|sdk):|^claude-' }
# "gemini:gemini-3.5-flash-lite" reads as "Gemini 3.5 Flash-Lite"; local ids stay as Ollama names them.
function Nice($m) {
    $s = Bare $m
    if ($s -match '^gemini:gemini-(.+)$') {
        $t = (Get-Culture).TextInfo.ToTitleCase(($Matches[1] -replace '-', ' ')) -replace 'Flash Lite', 'Flash-Lite'
        return "Gemini $t"
    }
    return ($s -replace '^(gemini|cerebras|groq|openai|anthropic|sdk):', '')
}

$ollamaUrl = [string](Setting 'ollama_url')
$custom    = AsList (Setting 'custom_models')
$modelHosts = Setting 'model_hosts'
if ($modelHosts -is [string]) { try { $modelHosts = $modelHosts | ConvertFrom-Json } catch { $modelHosts = $null } }

function ModelUrl($m) {
    if ($modelHosts -and $modelHosts.PSObject.Properties[[string](Bare $m)]) { return [string]$modelHosts.PSObject.Properties[[string](Bare $m)].Value }
    $id = (Bare $m) -replace ':latest$', ''
    foreach ($c in $custom) {
        if ((([string]$c.id) -replace ':latest$', '') -eq $id -and $c.url) { return [string]$c.url }
    }
    return $ollamaUrl
}

# Name a model host the way he knows it: this box, Mint, or its tailnet name.
$selfIps = @('localhost', '127.0.0.1')
try { $selfIps += @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { $_.IPAddress }) } catch {}
$peerName = @{}
if ($tailnet -and $tailnet.peers) { foreach ($p in $tailnet.peers) { if ($p.ip) { $peerName[[string]$p.ip] = [string]$p.host } } }
function HostLabel($url) {
    if (-not $url) { return 'an unknown host' }
    if ($url -match ':11435') { return 'the G16 (RTX 4070)' }
    try { $h = ([Uri]$url).Host } catch { return [string]$url }
    if ($selfIps -contains $h) { return 'the mini PC hub' }
    $n = $peerName[$h]
    if ($n -match 'mint') { return 'Mint (RTX 3050)' }
    if ($n) { return $n }
    return $h
}
function OnMint($url) { (HostLabel $url) -like 'Mint*' }
function Describe($m) {
    if (IsCloud $m) { return "$(Nice $m) (cloud)" }
    return "$(Bare $m) on $(HostLabel (ModelUrl $m))"
}
function Kind($models) {
    $c = @($models | Where-Object { IsCloud $_ }).Count
    $l = @($models).Count - $c
    if ($c -and $l) { return 'mixed' }
    if ($c) { return 'cloud' }
    return 'local'
}
function StudentName($id) {
    $b = Bare $id
    if ($b -match 'syrinx') { return "Syrinx ($b), PAN's own fine-tune" }
    if ($b -match 'omnipi') { return "OmniPi ($b), PAN's own fine-tune" }
    return $b
}
function Pretty($name) {
    if ($name -match 'madlad') { return 'MADLAD-400 3B' }
    if ($name -match 'm2m100') { return 'M2M-100 418M' }
    return $name
}

function Have($dir) { Test-Path (Join-Path $ModelsDir $dir) }

# ---------- Gemini free quota: one day per model, resetting at midnight Pacific ----------
$tzPac    = [TimeZoneInfo]::FindSystemTimeZoneById('Pacific Standard Time')
$tzEt     = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
$tzGr     = [TimeZoneInfo]::FindSystemTimeZoneById('GTB Standard Time')
$utcNow   = [DateTime]::UtcNow
$pacToday = ([TimeZoneInfo]::ConvertTimeFromUtc($utcNow, $tzPac)).Date
$resetUtc = [TimeZoneInfo]::ConvertTimeToUtc($pacToday, $tzPac)
$nextUtc  = [TimeZoneInfo]::ConvertTimeToUtc($pacToday.AddDays(1), $tzPac)
function At($utc, $tz, $fmt = 'h tt') { [TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz).ToString($fmt, $Inv) }
$resetText = "$(At $nextUtc $tzEt) ET, $(At $nextUtc $tzGr) local"

$gem = @{}
if ($fallback -and $fallback.events) {
    foreach ($ev in $fallback.events) {
        try { $d = ConvertFrom-Json ([string]$ev.data) } catch { continue }
        $m = [string]$d.model
        if (-not $m.StartsWith('gemini:')) { continue }
        # events.created_at is the hub's local time, not UTC.
        try { $at = [DateTime]::SpecifyKind([DateTime]::ParseExact([string]$ev.created_at, 'yyyy-MM-dd HH:mm:ss', $Inv), 'Local').ToUniversalTime() } catch { continue }
        if ($at -lt $resetUtc) { continue }
        if (-not $gem.ContainsKey($m)) { $gem[$m] = @{ limited = $false; slow = 0; failed = 0 } }
        if ($d.reason -eq 'rate-limit') { $gem[$m]['limited'] = $true }
        elseif ($d.reason -eq 'timeout') { $gem[$m]['slow'] += 1 }
        elseif (-not $d.ok) { $gem[$m]['failed'] += 1 }
    }
}
function GeminiState($m) {
    $g = $gem[[string]$m]
    if ($g -and $g.limited) { return @('bad', "out of free quota, back at $resetText") }
    if ($g -and $g.slow) { return @('warn', "$($g.slow) slow starts since the reset") }
    if ($g -and $g.failed) { return @('warn', "$($g.failed) errors since the reset") }
    return @('good', 'no failures since the reset')
}

# ---------- what each Ollama host has loaded right now ----------
$hostUrls = @(@($ollamaUrl) + @($custom | ForEach-Object { [string]$_.url }) | Where-Object { $_ } | Select-Object -Unique)
$loaded = @()
foreach ($u in $hostUrls) {
    $ps = Get-Api ($u.TrimEnd('/') + '/api/ps') 4
    $label = HostLabel $u
    if ($null -eq $ps) { $loaded += [pscustomobject]@{ Host = $label; Up = $false; Text = 'not answering'; GB = 0 }; continue }
    $ms = @($ps.models)
    $gb = [Math]::Round((($ms | Measure-Object -Property size -Sum).Sum) / 1GB, 1)
    $names = ($ms | ForEach-Object {
        $where = if ($_.size_vram -gt 0) { ' on GPU' } else { '' }
        '{0} {1} GB{2}' -f $_.name, ([double]$_.size / 1GB).ToString('0.0', $Inv), $where
    }) -join ', '
    if (-not $names) { $names = 'nothing loaded' }
    $loaded += [pscustomobject]@{ Host = $label; Up = $true; Text = $names; GB = $gb }
}
$ramGB = 0
try { $ramGB = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch {}

# ---------- the interpreter's timings, read from the code so they stay true ----------
$firstMs = 2500; $pauseMin = 2; $cloudFirst = @('ja', 'zh', 'yue')
try {
    $src = Get-Content $RouterJs -Raw
    if ($src -match 'INTERPRET_FIRST_TOKEN_MS = (\d+)') { $firstMs = [int]$Matches[1] }
    if ($src -match 'INTERPRET_CLOUD_PAUSE_MS = (\d+) \* 60_000') { $pauseMin = [int]$Matches[1] }
    if ($src -match 'INTERPRET_CLOUD_FIRST = new Set\(\[([^\]]*)\]\)') { $cloudFirst = @([regex]::Matches($Matches[1], "'([a-z]+)'") | ForEach-Object { $_.Groups[1].Value }) }
} catch {}
$langNames  = @{ ja = 'Japanese'; zh = 'Chinese'; yue = 'Cantonese'; ko = 'Korean' }
$cloudNames = @($cloudFirst | ForEach-Object { if ($langNames[$_]) { $langNames[$_] } else { $_ } })
$cloudLangs = if ($cloudNames.Count -gt 1) { ($cloudNames[0..($cloudNames.Count - 2)] -join ', ') + ' and ' + $cloudNames[-1] } else { $cloudNames -join '' }

# ---------- rows ----------
$sections = [ordered]@{}
function Add-Row($section, $job, $what, $kind, $limit, $note) {
    if (-not $sections.Contains($section)) { $sections[$section] = New-Object System.Collections.Generic.List[string] }
    $tag = switch ($kind) {
        'local' { "<span class='tag local'>local</span>" }
        'cloud' { "<span class='tag cloud'>cloud</span>" }
        'mixed' { "<span class='tag mixed'>local + cloud</span>" }
        'rules' { "<span class='tag rules'>no model</span>" }
        'dead'  { "<span class='tag dead'>dead</span>" }
        default { '' }
    }
    $nt = if ($note) { "<div class='note'>$note</div>" } else { '' }
    $sections[$section].Add("<div class='item'><div class='job'>$(E $job)</div><div class='what'>$what</div><div class='meta'>$tag$(E $limit)</div>$nt</div>")
}

$voiceChain = AsList (Setting 'ai_fallback_chain_voice')
$bgChain    = AsList (Setting 'ai_fallback_chain_background')
$student    = [string](Setting 'voice_student_model')
$gemModels  = @($voiceChain | Where-Object { ([string]$_).StartsWith('gemini:') })
$gemList    = if ($gemModels.Count) { ($gemModels | ForEach-Object { Nice $_ }) -join ' then ' } else { 'no cloud model' }
$xlateUp    = ($xlate -and $xlate.status -eq 'ok')
$xlateName  = if ($xlateUp) { Pretty ([string]$xlate.model) } else { 'the hub translator' }
$xlateText  = if ($xlateUp) { $xlateName + $(if ($xlate.referee) { ", with $(Pretty ([string]$xlate.referee)) checking it for invented words" } else { '' }) } else { 'NOT answering right now' }

$appVer = if ($apk -and $apk.versionName) { "app $($apk.versionName)" } else { 'the current app' }
$phone = "On your phone ($appVer)"
foreach ($r in $PhoneRows) { Add-Row $phone $r.Job (E $r.What) $r.Kind $r.Limit (E $r.Note) }

$hub = 'On the mini PC hub (CPU only, no GPU)'
$asr = 'NVIDIA Parakeet TDT 0.6B v2, English. It redoes the phone''s text, about half a second a sentence'
if (-not (Have 'parakeet-tdt-0.6b-v2-int8')) { $asr += ' (model files missing, so the phone''s own text is used)' }
Add-Row $hub 'Hears you, second pass' (E $asr) 'local' 'free'

$ears = @(
    @('sense-voice-zh-en-ja-ko-yue-int8', 'SenseVoice for Japanese, Chinese, Korean, Cantonese'),
    @('parakeet-tdt-0.6b-v3-int8', 'Parakeet v3 for 25 European languages, Greek included'),
    @('whisper-turbo-int8', 'Whisper turbo for everything else')
) | ForEach-Object { if (Have $_[0]) { $_[1] } else { "$($_[1]) (not installed)" } }
Add-Row $hub 'Hears other languages when interpreting' (E ($ears -join '. ')) 'local' 'free'

if ($student) {
    if ($student -like 'reader:*') {
        Add-Row $hub 'Talks to you' "<b>$(E (StudentName ($student -replace '^reader:', 'ollama:')))</b> in the voice reader (:7786)" 'local' 'free' 'Reads the conversation before your words arrive. First words 0.22 s on this CPU (Nov 5)'
    } else {
        $talkNote = if ((ModelUrl $student) -match ':11435') { 'Normal voice turns. The hub only runs it when the G16 is off' } else { 'Normal voice turns. About 2 seconds on this CPU' }
        Add-Row $hub 'Talks to you' "<b>$(E (StudentName $student))</b> on $(E (HostLabel (ModelUrl $student)))" 'local' 'free' $talkNote
    }
}
$backup = [string](Setting 'voice_student_backup')
if ($backup -like 'reader:*') {
    Add-Row $hub 'Talks to you when the G16 is off' "<b>$(E (StudentName ($backup -replace '^reader:', 'ollama:')))</b> in the voice reader (:7786)" 'local' 'free' 'Reads the conversation before your words arrive. First spoken chunk 0.30 s on this CPU, 1.17 s on Ollama (Nov 5)'
}
$chainHtml = ($voiceChain | ForEach-Object { E (Describe $_) }) -join ' &rarr; '
$handJob = if ($student) { 'Turns it hands back, and the backup when it is down' } else { 'Talks to you, in this order' }
Add-Row $hub $handJob $chainHtml (Kind $voiceChain) 'Gemini: 500 a day per model' 'Camera lines and anything the voice model cannot take. The local model here reads the full PAN prompt on CPU, which is slow: see the last 7 days below'

$pairs = if ($xlate.pairs) { "quickmt for $(E ($xlate.pairs -join ', ')), then " } else { '' }
$interp = "Only when the phone has no models for the language. The hub translator first: $pairs$(E $xlateText). Into $(E $cloudLangs), Gemini goes first ($(E $gemList)), each gets $($firstMs / 1000) s to start talking, then the translator. After 2 misses the cloud is skipped for $pauseMin minutes. If the translator is down, Gemini does every line"
Add-Row $hub 'Interprets and translates' $interp 'mixed' 'Gemini: 500 a day per model. Translator: free' 'quickmt is CC-BY-4.0, MADLAD from Google and M2M from Meta are open licences, all run with CTranslate2'

Add-Row $hub 'Looks things up' (E 'Weather and air quality (Open-Meteo), Wikipedia, currency (ECB rates), crypto (CoinGecko), news search (Google News), any web page you name, world clock') 'mixed' 'free public data, no keys' (E 'The answer is worded by Gemini first, the local model behind it')

$bgHtml = ($bgChain | ForEach-Object { E (Describe $_) }) -join ' &rarr; '
$bgNote = if ((Kind $bgChain) -eq 'local') { 'Steward, tasks, scout, dream, memory, self critique, recall, conversation state. Never uses the cloud' } else { 'Steward, tasks, scout, dream, memory, self critique, recall, conversation state' }
Add-Row $hub 'Background jobs' $bgHtml (Kind $bgChain) 'free' (E $bgNote)

$byModel = [ordered]@{}
foreach ($pair in @(@('routing_local_model', 'intent routing'), @('guardian_model', 'security scan'), @('sensitivity_model', 'privacy level'), @('c2d_local_model', 'data staking queries'))) {
    $v = [string](Setting $pair[0])
    if ($v) { if (-not $byModel.Contains($v)) { $byModel[$v] = @() }; $byModel[$v] += $pair[1] }
}
$checks = @($byModel.Keys | ForEach-Object { "$(Nice $_) for $($byModel[$_] -join ', ')" })
$gm = [string](Setting 'guardian_mode')
$checksNote = if ($gm) { "Security scan mode: $gm" } else { '' }
Add-Row $hub 'Sorting and safety checks' (E ($checks -join '. ')) (Kind @($byModel.Keys)) 'free' (E $checksNote)

$emb = [string](Setting 'embedding_model'); $dim = [string](Setting 'embedding_dim')
Add-Row $hub 'Memory search' (E ("$emb" + $(if ($dim) { ", $dim dimensions" } else { '' }))) (Kind @($emb)) 'free'
Add-Row $hub 'Photos the phone cannot do' (E 'moondream describes the picture, gemma4:e2b answers about it') 'local' 'free' (E 'Never sent to the cloud')
Add-Row $hub 'Knows what you are doing (Intuition)' (E 'Rules only, no model, since Nov 3') 'rules' 'free'

$mint = 'On Mint (RTX 3050)'
$mintModels = @($custom | Where-Object { $_.url -and (OnMint ([string]$_.url)) } | ForEach-Object { Bare $_.id })
if (OnMint $ollamaUrl) {
    Add-Row $mint 'GPU' (E 'Every local model that has no host of its own runs here') 'local' 'free' (E 'The GAME MODE button moves PAN back to the mini PC')
} elseif ($mintModels.Count) {
    Add-Row $mint 'GPU' (E ($mintModels -join ', ')) 'local' 'free' (E 'Only these models; everything else is on the mini PC')
} else {
    Add-Row $mint 'GPU' (E 'Not used by PAN right now. Every model points at the mini PC') '' '' (E 'The GAME MODE button moves PAN between Mint and the mini PC')
}

$cloud = 'In the cloud'
$gemHtml = ($gemModels | ForEach-Object { $st = GeminiState $_; "<div><span class='dot $($st[0])'></span><b>$(E (Nice $_))</b>: $(E $st[1])</div>" }) -join ''
if (-not $gemHtml) { $gemHtml = 'Not in the voice chain right now' }
Add-Row $cloud 'Google Gemini (AI Studio free tier)' $gemHtml 'cloud' "500 requests a day per model, resets $resetText" (E 'Paid would be 0.30 dollars in and 2.50 out per million tokens for 3.5 Flash-Lite, 0.25 and 1.50 for 3.1 (checked Nov 4 2026)')
$term = [string](Setting 'terminal_ai_model')
Add-Row $cloud 'Anthropic Claude' (E ("PAN's terminal sessions run $term. Your Claude Code threads too")) 'cloud' 'your Claude subscription'
$rc = [string](Setting 'routing_cloud_model')
if ($rc -match '^cerebras:') {
    Add-Row $cloud 'Cerebras' (E "Still named in routing_cloud_model ($rc), but the account needs billing (402) and that model is retired. Nothing runs there") 'dead' ''
}

if ($modelHosts) {
    Add-Row 'On this laptop (the G16)' 'Talks to you' (E 'Syrinx on its RTX 4070, reached through a tunnel from the hub') 'local' 'free' 'If the G16 is off, the same model on the hub answers'
} else {
    Add-Row 'On this laptop (the Dell)' 'Nothing of PAN''s' (E 'No PAN models run here. It runs your Claude Code threads') '' ''
}

# ---------- right now ----------
$nowLines = New-Object System.Collections.Generic.List[string]
function Now-Line($cls, $html) { $nowLines.Add("<div class='nl'><span class='dot $cls'></span>$html</div>") }
if ($student) { Now-Line 'good' "Talking to you: <b>$(E (StudentName $student))</b>, local" }
$ic = if ($xlateUp) { 'good' } else { 'bad' }
if ($xlateUp) { Now-Line $ic "Interpreting: <b>$(E $xlateName)</b> on the hub, with <b>$(E $gemList)</b> first into $(E $cloudLangs)" }
else { Now-Line $ic "Interpreting: <b>$(E $gemList)</b> only, the hub translator is not answering" }
foreach ($g in $gemModels) { $st = GeminiState $g; Now-Line $st[0] "$(E (Nice $g)): $(E $st[1])" }
$hubLoad = $loaded | Where-Object { $_.Host -eq 'the mini PC hub' } | Select-Object -First 1
if ($hubLoad) {
    $of = if ($ramGB) { " of $ramGB GB" } else { '' }
    Now-Line $(if ($hubLoad.Up) { 'good' } else { 'bad' }) "Hub has <b>$($hubLoad.GB) GB$of</b> of RAM in loaded models"
}
$mintUse = if ((OnMint $ollamaUrl) -or $mintModels.Count) { 'used by PAN' } else { 'not used by PAN' }
Now-Line 'muted' "Mint GPU: $mintUse"

$loadedRows = ($loaded | ForEach-Object {
    $dot = if ($_.Up) { 'good' } else { 'bad' }
    "<tr><td><span class='dot $dot'></span>$(E $_.Host)</td><td class='muted'>$(E $_.Text)</td></tr>"
}) -join ''
$xd = if ($xlateUp) { 'good' } else { 'bad' }
$loadedRows += "<tr><td><span class='dot $xd'></span>Translator (:7784)</td><td class='muted'>$(E $xlateText)</td></tr>"

# ---------- what actually ran, last 7 days ----------
$ranRows = ''
if ($routing -and $routing.callers) {
    foreach ($c in @($routing.callers | Sort-Object { [int]$_.calls_7d } -Descending)) {
        $label = $CallerWords[[string]$c.caller]
        if (-not $label) { $label = [string]$c.caller }
        $mind = $CallerMind[[string]$c.caller]
        $target = if ($mind) { [double]$mind[1] } else { -1 }
        $first = $true
        foreach ($m in @($c.models | Sort-Object { [int]$_.calls_7d } -Descending)) {
            $where = [string]$m.where
            $cls = if ($where -eq 'cloud') { 'cloud' } elseif ($where -eq 'local') { 'local' } else { 'unk' }
            $lat = if ($m.avg_latency_ms) { ([double]$m.avg_latency_ms / 1000).ToString('0.0', $Inv) } else { '-' }
            $latCls = 'muted'
            if ($m.avg_latency_ms -and $target -gt 0) {
                $secs = [double]$m.avg_latency_ms / 1000
                $latCls = if ($secs -le $target) { 'ok' } elseif ($secs -le 3 * $target) { 'slow' } else { 'over' }
            }
            $lbl = ''; $should = ''
            if ($first) {
                $lbl = (E $label) + $(if ($mind) { "<div class='muted'>$(E $mind[0])</div>" } else { '' })
                $should = if ($target -gt 0) { "$($target.ToString('0.#', $Inv)) s" } elseif ($target -eq 0) { 'background' } else { '' }
            }
            $ranRows += "<tr><td>$lbl</td><td>$(E (Nice $m.model))</td><td><span class='tag $cls'>$(E $where)</span></td><td class='num'>$($m.calls_7d)</td><td class='num $latCls'>$lat</td><td class='num muted'>$should</td></tr>"
            $first = $false
        }
    }
}
if (-not $ranRows) { $ranRows = "<tr><td colspan='6' class='muted'>The usage API did not answer</td></tr>" }

$whereLines = ($WhereWeAre | ForEach-Object { "<div class='nl'><span class='dot $($_[0])'></span>$(E $_[1])</div>" }) -join ''
$stageRows = ($Stages | ForEach-Object { "<tr><td>$(E $_[0])</td><td class='muted'>$(E $_[1])</td><td>$(E $_[2])</td><td>$(E $_[3])</td><td class='muted'>$(E $_[4])</td></tr>" }) -join ''
$hwItems = ($Hardware | ForEach-Object {
    $d = if ($_[0]) { "<span class='dot $($_[0])'></span>" } else { "<span class='dot'></span>" }
    "<div class='item'><div class='job'>$d$(E $_[1])</div><div class='what'>$(E $_[2])</div></div>"
}) -join ''
$gpuRows = ($GpuPrices | ForEach-Object { "<tr><td>$(E $_[0])</td><td class='muted'>$(E $_[1])</td><td>$(E $_[2])</td><td>$(E $_[3])</td><td class='muted'>$(E $_[4])</td></tr>" }) -join ''

# A turn is PAN's real average: about 2,800 tokens in and 150 out.
function MonthCost($turnsPerDay, $inPrice, $outPrice) {
    $c = $turnsPerDay * 30 * (2800 * $inPrice + 150 * $outPrice) / 1e6
    if ($c -eq 0) { return '$0' }
    if ($c -lt 10) { return '$' + $c.ToString('0.00', $Inv) }
    return '$' + [math]::Round($c).ToString($Inv)
}
$cloudRows = ($CloudPrices | ForEach-Object {
    $price = if ($_[1] -gt 0) { '$' + ([double]$_[1]).ToString('0.00', $Inv) + ' / $' + ([double]$_[2]).ToString('0.00', $Inv) } else { 'free' }
    "<tr><td>$(E $_[0])</td><td class='num'>$price</td><td class='num'>$(E $_[3])</td><td class='num'>$(E $_[4])</td><td class='num'>$(MonthCost $TurnsNormal $_[1] $_[2])</td><td class='num'>$(MonthCost $TurnsHeavy $_[1] $_[2])</td></tr>"
}) -join ''
$cloudRows += '<tr><td>Rented GPU on all month (RunPod L40S, what we paid)</td><td class="num">$1.09 an hour</td><td class="num">-</td><td class="num">-</td><td class="num">$785</td><td class="num">$785</td></tr>'
$ladderRows = ($Ladder | ForEach-Object { "<tr><td>$(E $_[0])</td><td class='num'>$(E $_[1])</td><td class='muted'>$(E $_[2])</td></tr>" }) -join ''
$japanRows = ($Japan | ForEach-Object { "<tr><td><span class='dot $($_[0])'></span>$(E $_[1])</td><td class='num'>$(E $_[2])</td><td class='muted'>$(E $_[3])</td></tr>" }) -join ''
$perDay = ''
if ($routing -and $routing.totals) { $perDay = "About $($routing.totals.local_calls_per_day) local and $($routing.totals.cloud_calls_per_day) cloud calls a day." }

$body = ''
foreach ($k in $sections.Keys) { $body += "<div class='card'><h2>$(E $k)</h2>$($sections[$k] -join '')</div>`n" }
$built = "$(At $utcNow $tzEt 'MMM d, h:mm tt') ET, $(At $utcNow $tzGr 'h:mm tt') local"

$html = @"
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>PAN Models</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
     background:#0e1117;color:#e6edf3;max-width:860px;margin:0 auto}
h1{font-size:18px;margin:0 0 2px}
.sub{color:#8b949e;font-size:13px;margin-bottom:18px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 6px;font-weight:600}
.nl{padding:3px 0}
.item{padding:10px 0;border-bottom:1px solid #21262d}
.item:last-child{border-bottom:none}
.job{font-weight:600}
.what{margin-top:2px}
.meta{margin-top:4px;font-size:13px;color:#8b949e}
.note{margin-top:3px;font-size:13px;color:#8b949e}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px;margin-right:7px;vertical-align:1px}
.tag.local{background:#12361f;color:#3fb950}
.tag.cloud{background:#3a2a0b;color:#d29922}
.tag.mixed{background:#132a4a;color:#58a6ff}
.tag.rules{background:#2d2140;color:#bc8cff}
.tag.dead{background:#3d1214;color:#f85149}
.tag.unk{background:#21262d;color:#8b949e}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:5px 8px 5px 0;border-bottom:1px solid #21262d;vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr:last-child td{border-bottom:none}
.muted{color:#8b949e}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle;background:#8b949e}
.dot.good{background:#3fb950}.dot.warn{background:#d29922}.dot.bad{background:#f85149}
td.ok{color:#3fb950}td.slow{color:#d29922}td.over{color:#f85149;font-weight:600}
.foot{color:#6e7681;font-size:11px;text-align:center;margin-top:18px}
@media(prefers-color-scheme:light){
 body{background:#f6f8fa;color:#1f2328}
 .card{background:#fff;border-color:#d1d9e0}
 td,.item{border-color:#d1d9e0}
 .tag.local{background:#dafbe1;color:#1a7f37}
 .tag.cloud{background:#fff1c2;color:#9a6700}
 .tag.mixed{background:#ddf4ff;color:#0969da}
 .tag.rules{background:#fbefff;color:#8250df}
 .tag.dead{background:#ffebe9;color:#cf222e}
 .tag.unk{background:#eaeef2;color:#57606a}
 td.ok{color:#1a7f37}td.slow{color:#9a6700}td.over{color:#cf222e}
}
</style></head><body>

<h1>PAN Models</h1>
<div class="sub">Everything PAN runs, where it runs, and its limits &middot; built $built</div>

<div class="card">
  <h2>Right now</h2>
  $($nowLines -join '')
</div>

<div class="card">
  <h2>Where we are (Nov 4)</h2>
  $whereLines
</div>

<div class="card">
  <h2>Talking like a person</h2>
  <div class="scroll"><table>
    <tr class="muted"><td>Step</td><td>A person</td><td>PAN should be</td><td>PAN now</td><td>What closes the gap</td></tr>
    $stageRows
  </table></div>
  <div class="note">People answer a median 0.1 to 0.2 s after the other person stops (Stivers et al. 2009), and past about 0.7 s a pause starts to sound like hesitation. PAN's voice bench counts 0.6 s typical and 1 s on slow turns as human-like, and 1 s and 1.8 s as the pass line. Slow turns are the slowest 1 in 10.</div>
</div>

<div class="card">
  <h2>Getting to 0.6 s</h2>
  <div class="scroll"><table>
    <tr class="muted"><td>Add this</td><td class="num">Gap after it</td><td>Why</td></tr>
    $ladderRows
  </table></div>
  <div class="note">Each step needs the ones above it. The floor is about 0.3 s, because PAN has to hear 0.2 s of silence to know you stopped. Past an 8 GB card, a bigger GPU saves very little: Syrinx is small. Turns that need a tool or a memory search take longer.</div>
</div>

<div class="card">
  <h2>What it would take to run it all locally</h2>
  $hwItems
  <div class="scroll"><table>
    <tr class="muted"><td>Card</td><td>Memory speed</td><td>Cheapest new</td><td>Well reviewed</td><td>For PAN</td></tr>
    $gpuRows
  </table></div>
  <div class="note">Prices: Skroutz, new cards, checked Nov 4. They move fast, so check again before buying. The 5060 Ti launched at 429 dollars in April 2025 and was about 411 euros in Germany last December, before the memory shortage. Measured where it says so, the rest are estimates.</div>
</div>

<div class="card">
  <h2>Or pay the cloud by the word</h2>
  <div class="scroll"><table>
    <tr class="muted"><td>Service (gpt-oss-120b unless named)</td><td class="num">In / out, per 1M tokens</td><td class="num">First word</td><td class="num">Tokens/s</td><td class="num">Normal month</td><td class="num">Heavy month</td></tr>
    $cloudRows
  </table></div>
  <div class="note">Normal month: 130 turns a day, what PAN did this week. Heavy month: 500 turns a day. A turn is PAN's average, about 2,800 tokens in and 150 out. First word and tokens/s are OpenRouter's live medians on Nov 4, measured at their servers, so add your network. Cerebras takes 0.55 s for a whole reply. These are stock models: Syrinx cannot run on them, and what you say goes to them. PAN already streams from Cerebras, so it only needs billing turned on (adding a card gives a one time 5 dollar credit). OpenRouter is one key for all of these and moves to the next if one fails (99.6% served, 91.2% without it), for a 5.5% fee on credit. Everything PAN ran this week would be about 10 dollars a month on Cerebras, but background jobs read your private memory, so they stay local.</div>
</div>

<div class="card">
  <h2>From Japan</h2>
  <div class="scroll"><table>
    <tr class="muted"><td>Setup</td><td class="num">Gap after you stop</td><td>Cost</td></tr>
    $japanRows
  </table></div>
  <div class="note">Home to Tokyo is 0.27 to 0.32 s round trip, measured from here on Nov 4, and no GPU shortens it. The gaps are estimates. The phone sends the whole clip after you stop, about 200 KB for 5 s, and on a long link that takes several round trips, about 1.2 s in all. Sent while you talk, the trip costs about 0.3 s. A human interpreter runs 2 to 3 s behind, so most of these are fine for interpreting.</div>
</div>

$body
<div class="card">
  <h2>Loaded right now</h2>
  <table>$loadedRows</table>
</div>

<div class="card">
  <h2>What actually ran, last 7 days</h2>
  <div class="scroll"><table>
    <tr class="muted"><td>Job, and what it is in a person</td><td>Model</td><td>Where</td><td class="num">Calls</td><td class="num">Secs</td><td class="num">Should be</td></tr>
    $ranRows
  </table></div>
  <div class="note">$perDay Secs is the average whole call, start to end; a spoken reply starts talking before its call ends. Green is fast enough for a real conversation, amber is up to 3 times too slow, red is more than that. Background jobs have no target, but they share the CPU with your turn.</div>
</div>

<div class="foot">Rebuilt from the hub's live settings each time it is opened (at most every 5 minutes) &middot; phone rows match $(E $appVer) &middot; service/scripts/push-pan-models.ps1</div>
</body></html>
"@

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$html | Out-File -FilePath $OutFile -Encoding utf8 -Force

Write-Output "wrote $OutFile"
Write-Output "student=$student chain=$($voiceChain -join ',') translator=$xlateUp gemini=$(($gemModels | ForEach-Object { "$(Bare $_):$((GeminiState $_)[0])" }) -join ',')"
