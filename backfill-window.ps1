# Run the embeddings backfill only overnight.
#
#   backfill-window.ps1 on   -> allow it, and boot a Craft so it starts now
#   backfill-window.ps1 off  -> disallow it and abort the current run
#
# WHY A WINDOW: on 2026-08-25 the backfill was grinding through 135,258
# unembedded events in the middle of the working day on a CPU-only box that
# also serves voice. Embedding is the single heaviest recurring job PAN runs,
# and nothing needs it to finish during waking hours.
#
# WHY A CRAFT SWAP TO START: there is no start endpoint. Backfill auto-starts
# on Craft boot unless embeddings_backfill_disabled is set, so clearing the flag
# alone does nothing until the next boot. The swap is the trigger.
param([Parameter(Mandatory=$true)][ValidateSet('on','off')][string]$Mode)

$hub = 'http://127.0.0.1:7777'
$ErrorActionPreference = 'Continue'

function Post($path, $bodyObj) {
    try {
        $body = if ($bodyObj) { $bodyObj | ConvertTo-Json -Compress } else { '{}' }
        Invoke-RestMethod -Uri ($hub + $path) -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60
    } catch { "  FAILED $path : $($_.Exception.Message)" }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

if ($Mode -eq 'on') {
    $r = Post '/api/v1/memory/backfill-disable' @{ disable = $false }
    "$stamp  allow  -> $($r.message)"
    # Boot a new Craft so the backfill actually starts. Swap keeps PTYs alive.
    $s = Post '/api/carrier/swap' $null
    "$stamp  swap   -> $($s.message)"
} else {
    $r = Post '/api/v1/memory/backfill-disable' @{ disable = $true }
    "$stamp  block  -> $($r.message)"
}

try {
    $st = Invoke-RestMethod -Uri ($hub + '/api/v1/memory/backfill-status') -TimeoutSec 30
    "$stamp  status -> indexed=$($st.indexed) remaining=$($st.remaining) running=$($st.running)"
} catch { }
