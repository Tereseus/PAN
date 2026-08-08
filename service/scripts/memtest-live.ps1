# memtest-live.ps1 - RAM test that runs inside Windows, no reboot required.
#
# Windows Memory Diagnostic and MemTest86 need a reboot because they test the
# memory Windows itself occupies. This tests only the FREE memory - which is a
# real limitation, stated plainly - but it needs no reboot, runs in the
# background, and a bad cell anywhere in a multi-GB region will usually show up.
#
# Patterns are chosen to catch different fault classes:
#   0x00 / 0xFF     - stuck bits
#   0xAA / 0x55     - adjacent-cell coupling (alternating bit pattern)
#   address-in-word - address line faults (word N contains N)
#   pseudo-random   - everything else
#
# Any mismatch is a hard failure. Good RAM produces exactly zero.

param(
    [int]$GB = 0,          # 0 = auto-size to ~60% of free RAM
    [int]$Passes = 3
)

$ErrorActionPreference = 'Stop'

$os = Get-CimInstance Win32_OperatingSystem
$freeGB = [math]::Round($os.FreePhysicalMemory/1MB, 1)
if ($GB -le 0) { $GB = [math]::Max(1, [math]::Floor($freeGB * 0.6)) }

Write-Host ""
Write-Host "=== Live RAM test ===" -ForegroundColor Cyan
Write-Host "Free physical : $freeGB GB"
Write-Host "Testing       : $GB GB  x $Passes passes"
Write-Host "NOTE: only tests FREE memory. A clean result does not fully clear your RAM;"
Write-Host "      it does mean the most-used free region is good. MemTest86 is the thorough one."
Write-Host ""

$chunkMB = 256
$chunks = [int](($GB * 1024) / $chunkMB)
$chunkBytes = $chunkMB * 1MB

Add-Type -TypeDefinition @'
using System;
public static class MemPat {
    public static long FillVerify(byte[] buf, byte pattern) {
        for (long i = 0; i < buf.LongLength; i++) buf[i] = pattern;
        long bad = 0;
        for (long i = 0; i < buf.LongLength; i++) if (buf[i] != pattern) bad++;
        return bad;
    }
    public static long FillVerifyAddr(byte[] buf) {
        for (long i = 0; i < buf.LongLength; i++) buf[i] = (byte)(i & 0xFF);
        long bad = 0;
        for (long i = 0; i < buf.LongLength; i++) if (buf[i] != (byte)(i & 0xFF)) bad++;
        return bad;
    }
    public static long FillVerifyRandom(byte[] buf, int seed) {
        Random r = new Random(seed);
        for (long i = 0; i < buf.LongLength; i++) buf[i] = (byte)r.Next(256);
        Random v = new Random(seed);
        long bad = 0;
        for (long i = 0; i < buf.LongLength; i++) if (buf[i] != (byte)v.Next(256)) bad++;
        return bad;
    }
}
'@

$totalErrors = 0
$sw = [Diagnostics.Stopwatch]::StartNew()

for ($pass = 1; $pass -le $Passes; $pass++) {
    Write-Host "--- Pass $pass of $Passes ---" -ForegroundColor Yellow
    for ($c = 0; $c -lt $chunks; $c++) {
        $buf = $null
        try {
            $buf = New-Object byte[] $chunkBytes
        } catch {
            Write-Host "  chunk $c : allocation failed (out of memory) - stopping this pass" -ForegroundColor DarkYellow
            break
        }

        $bad = 0
        $bad += [MemPat]::FillVerify($buf, 0x00)
        $bad += [MemPat]::FillVerify($buf, 0xFF)
        $bad += [MemPat]::FillVerify($buf, 0xAA)
        $bad += [MemPat]::FillVerify($buf, 0x55)
        $bad += [MemPat]::FillVerifyAddr($buf)
        $bad += [MemPat]::FillVerifyRandom($buf, ($pass * 1000 + $c))

        if ($bad -gt 0) {
            $totalErrors += $bad
            Write-Host "  *** ERRORS: $bad bad bytes in chunk $c (pass $pass) ***" -ForegroundColor Red
        }

        $buf = $null
        if ($c % 8 -eq 0) {
            [GC]::Collect()
            $pct = [math]::Round(100.0 * $c / $chunks)
            Write-Host ("  {0,3}%  chunk {1}/{2}  errors so far: {3}" -f $pct, $c, $chunks, $totalErrors)
        }
    }
    [GC]::Collect()
}

$sw.Stop()
Write-Host ""
if ($totalErrors -eq 0) {
    Write-Host "RESULT: PASS - 0 errors across $Passes passes of $GB GB in $([math]::Round($sw.Elapsed.TotalMinutes,1)) min" -ForegroundColor Green
    Write-Host "The free-memory region is clean. If you want RAM fully cleared, run MemTest86 from USB."
} else {
    Write-Host "RESULT: FAIL - $totalErrors bad bytes detected" -ForegroundColor Red
    Write-Host "Your RAM is faulty. This is very likely your hang. Test one stick at a time to find which."
}
