param([Parameter(Mandatory = $true)][string]$Run)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Run).Path
$manifest = Get-Content -LiteralPath "$root/registration.json" -Raw | ConvertFrom-Json -DateKind String
$end = [DateTimeOffset]::Parse($manifest.deadlineUTC)
$maxHours = 24
if ($manifest.id -eq 'human-qfilter-reason-20261123-0700-v2' -and
    $manifest.trainingDeadlineUTC -eq '2026-11-24T12:00:00.000Z' -and
    $manifest.deadlineUTC -eq '2026-11-24T15:00:00.000Z') {
    $maxHours = 35
    $start = [DateTimeOffset]::Parse($manifest.startUTC)
    if ($start -gt [DateTimeOffset]::UtcNow -or ($end - $start).TotalHours -gt $maxHours) {
        throw 'Invalid registered human and reason training window'
    }
}
if ($manifest.durationHours -le 0 -or $manifest.durationHours -gt $maxHours -or $manifest.restartExtendsDeadline -ne $false) {
    throw "Expected one bounded owner-authorized window of at most $maxHours hours"
}
if ([DateTimeOffset]::UtcNow -ge $end) { throw 'Evaluation expired' }
Add-Type @'
using System.Runtime.InteropServices;
public static class EvaluationPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint state);
}
'@
try {
    if ([EvaluationPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Power request failed' }
    while ([DateTimeOffset]::UtcNow -lt $end -and !(Test-Path -LiteralPath "$root/FINISHED")) {
        @{ pid = $PID; phase = 'awake'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o'); deadlineUTC = $manifest.deadlineUTC; powerPlanChanged = $false; displayRequired = $false } | ConvertTo-Json | Set-Content -LiteralPath "$root/awake-status.json" -Encoding utf8NoBOM
        Start-Sleep -Seconds 10
    }
} finally {
    [void][EvaluationPower]::SetThreadExecutionState([uint32]2147483648)
    @{ pid = $PID; phase = 'released'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o'); deadlineUTC = $manifest.deadlineUTC; powerPlanChanged = $false } | ConvertTo-Json | Set-Content -LiteralPath "$root/awake-status.json" -Encoding utf8NoBOM
}
