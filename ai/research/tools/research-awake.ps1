param([Parameter(Mandatory = $true)][string]$Campaign)
$ErrorActionPreference = 'Stop'
$campaignPath = (Resolve-Path -LiteralPath $Campaign).Path
$manifest = Get-Content -LiteralPath "$campaignPath/campaign.json" -Raw | ConvertFrom-Json -DateKind String
if ($manifest.deadlineUTC -ne '2026-11-11T17:00:00.000Z') { throw 'Unexpected research cutoff' }
$end = [DateTimeOffset]::Parse($manifest.deadlineUTC)
if ([DateTimeOffset]::UtcNow -ge $end) { throw 'Research window ended' }
Add-Type @'
using System.Runtime.InteropServices;
public static class ResearchPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint state);
}
'@
$status = "$campaignPath/awake-status.json"
try {
    # System only: allow the display to turn off, without editing the power plan.
    if ([ResearchPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Power request failed' }
    while ([DateTimeOffset]::UtcNow -lt $end) {
        @{ pid = $PID; phase = 'awake'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o');
           deadlineUTC = $manifest.deadlineUTC; displayRequired = $false; powerPlanChanged = $false } |
            ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8NoBOM
        Start-Sleep -Seconds 20
    }
} finally {
    [void][ResearchPower]::SetThreadExecutionState([uint32]2147483648)
    @{ pid = $PID; phase = 'released'; updatedAtUTC = [DateTimeOffset]::UtcNow.ToString('o');
       deadlineUTC = $manifest.deadlineUTC; powerPlanChanged = $false } |
        ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8NoBOM
}
