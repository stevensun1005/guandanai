param([Parameter(Mandatory = $true)][string]$Campaign)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Campaign).Path
$manifest = Get-Content -LiteralPath "$root/authorization.json" -Raw | ConvertFrom-Json -DateKind String
if ($manifest.deadlineUTC -ne '2026-11-12T14:00:00.000Z') { throw 'Unexpected new cutoff' }
$end = [DateTimeOffset]::Parse($manifest.deadlineUTC)
if ([DateTimeOffset]::UtcNow -ge $end) { throw 'Window expired' }
Add-Type @'
using System.Runtime.InteropServices;
public static class OvernightPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint state);
}
'@
try {
    if ([OvernightPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Power request failed' }
    while ([DateTimeOffset]::UtcNow -lt $end) {
        @{ pid = $PID; phase = 'awake'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o'); deadlineUTC = $manifest.deadlineUTC; powerPlanChanged = $false; displayRequired = $false } | ConvertTo-Json | Set-Content -LiteralPath "$root/awake-status.json" -Encoding utf8NoBOM
        Start-Sleep -Seconds 15
    }
} finally {
    [void][OvernightPower]::SetThreadExecutionState([uint32]2147483648)
    @{ pid = $PID; phase = 'released'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o'); deadlineUTC = $manifest.deadlineUTC; powerPlanChanged = $false } | ConvertTo-Json | Set-Content -LiteralPath "$root/awake-status.json" -Encoding utf8NoBOM
}
