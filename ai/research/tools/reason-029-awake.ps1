param([Parameter(Mandatory=$true)][string]$Run)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath $Run).Path
$taskReg=Get-Content -LiteralPath "$taskRoot/registration.json" -Raw | ConvertFrom-Json
if($taskReg.deadlineUTC -ne '2026-11-14T18:00:00.000Z'){throw 'Unexpected owner cutoff'}
Add-Type @'
using System.Runtime.InteropServices;
public static class ReasonPower {
 [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint state);
}
'@
$taskEncoding=New-Object System.Text.UTF8Encoding($false)
function Write-TaskAwake($record){[System.IO.File]::WriteAllText("$taskRoot/awake-status.json",($record|ConvertTo-Json),$taskEncoding)}
try {
 if([ReasonPower]::SetThreadExecutionState([uint32]2147483649) -eq 0){throw 'Power request failed'}
 while([DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($taskReg.deadlineUTC) -and !(Test-Path -LiteralPath "$taskRoot/FINISHED")){
  Write-TaskAwake @{pid=$PID;phase='awake';deadlineUTC=$taskReg.deadlineUTC;updatedAtUTC=[DateTimeOffset]::UtcNow.ToString('o');powerPlanChanged=$false;displayRequired=$false}
  Start-Sleep -Seconds 1
 }
} finally {
 [void][ReasonPower]::SetThreadExecutionState([uint32]2147483648)
 Write-TaskAwake @{pid=$PID;phase='released';updatedAtUTC=[DateTimeOffset]::UtcNow.ToString('o');powerPlanChanged=$false}
}
