param([Parameter(Mandatory=$true)][string]$Run)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath $Run).Path
$taskPlan=Get-Content -LiteralPath "$taskRoot/protocol.json" -Raw | ConvertFrom-Json
$taskReg=Get-Content -LiteralPath "$taskRoot/registration.json" -Raw | ConvertFrom-Json
if((Test-Path -LiteralPath "$taskRoot/STOP") -or (Test-Path -LiteralPath "$taskRoot/FINISHED")){throw 'Closed interim evaluation'}
if((Get-FileHash -LiteralPath "$taskRoot/protocol.json" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskReg.protocolSHA256){throw 'Protocol changed'}
if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($taskReg.evaluationDeadlineUTC)){throw 'Interim deadline expired'}
$taskLock=[System.IO.File]::Open("$taskRoot/controller.lock",[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::Read)
$taskBytes=[Text.Encoding]::UTF8.GetBytes("$PID")
$taskLock.Write($taskBytes,0,$taskBytes.Length);$taskLock.Close()
$taskWorkers=@();$taskGuardian=$null;$taskPhase='evaluation';$taskFailed=$false
$taskEncoding=New-Object System.Text.UTF8Encoding($false)
function Write-TaskJson($file,$value){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 30),$taskEncoding)}
function Write-TaskStop($reason){if(!(Test-Path -LiteralPath "$taskRoot/STOP")){Write-TaskJson "$taskRoot/STOP" @{reason=$reason;atUTC=[DateTimeOffset]::UtcNow.ToString('o')}}}
try {
 $taskGuardian=Start-Process -FilePath $taskPlan.node -ArgumentList @("$($taskPlan.sourceRoot)/ai/research/tools/reason-029-window.mjs","--run=$taskRoot",'--watch') -WorkingDirectory $taskPlan.sourceRoot -WindowStyle Hidden -RedirectStandardOutput "$taskRoot/guardian.stdout.log" -RedirectStandardError "$taskRoot/guardian.stderr.log" -PassThru
 $null=$taskGuardian.Handle
 for($taskSlot=0;$taskSlot -lt $taskPlan.workers;$taskSlot++){
  $taskChild=Start-Process -FilePath $taskPlan.node -ArgumentList @('--expose-gc','--max-old-space-size=768',"$($taskPlan.sourceRoot)/ai/research/tools/reason-029-window.mjs","--run=$taskRoot",'--evaluate=final-vs-old',"--slot=$taskSlot") -WorkingDirectory $taskPlan.sourceRoot -WindowStyle Hidden -RedirectStandardOutput "$taskRoot/worker-$taskSlot.stdout.log" -RedirectStandardError "$taskRoot/worker-$taskSlot.stderr.log" -PassThru
  $taskWorkers+=,$taskChild
  $null=$taskChild.Handle
 }
 Write-TaskJson "$taskRoot/controller.json" @{pid=$PID;phase=$taskPhase;guardianPID=$taskGuardian.Id;workerPIDs=@($taskWorkers|ForEach-Object {$_.Id});actualStartedUTC=[DateTimeOffset]::UtcNow.ToString('o');deadlineUTC=$taskReg.evaluationDeadlineUTC}
 while(@($taskWorkers|Where-Object {!$_.HasExited}).Count -gt 0){
  if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($taskReg.evaluationDeadlineUTC)){Write-TaskStop 'fixed-interim-deadline'}
  if($taskGuardian.HasExited){Write-TaskStop 'guardian-exited';throw 'Guardian exited before workers'}
  foreach($taskChild in $taskWorkers){if($taskChild.HasExited){$taskChild.WaitForExit();if($taskChild.ExitCode -ne 0){Write-TaskStop 'worker-failed';throw 'Interim worker failed'}}}
  Start-Sleep -Seconds 3
 }
 foreach($taskChild in $taskWorkers){$taskChild.WaitForExit();if($taskChild.ExitCode -ne 0){throw 'Worker nonzero exit'}}
 for($taskSlot=0;$taskSlot -lt $taskPlan.workers;$taskSlot++){$taskStatus=Get-Content -LiteralPath "$taskRoot/worker-$taskSlot.json" -Raw|ConvertFrom-Json;if($taskStatus.phase -ne 'complete'){throw 'Partial interim evaluation; no complete conclusion'}}
 $taskPhase='summarize'
 & $taskPlan.python -B -X utf8 "$($taskPlan.sourceRoot)/ai/danMCai/evaluation/summarize-round-pairs.py" --protocol "$taskRoot/protocol.json" --results $taskRoot --output "$taskRoot/summary.json" *> "$taskRoot/summary.log"
 if($LASTEXITCODE -ne 0){throw 'Strict pair summary failed'}
 $taskPhase='complete'
 Write-TaskJson "$taskRoot/controller.json" @{pid=$PID;phase=$taskPhase;guardianPID=$taskGuardian.Id;workerPIDs=@($taskWorkers|ForEach-Object {$_.Id});completedUTC=[DateTimeOffset]::UtcNow.ToString('o');optimizerUpdates=0}
} catch {
 $taskFailed=$true;$taskPhase='failed';Write-TaskStop 'interim-controller-failed'
 Write-TaskJson "$taskRoot/failure.json" @{error=$_.ToString();phase=$taskPhase;atUTC=[DateTimeOffset]::UtcNow.ToString('o')}
} finally {
 if($taskFailed){foreach($taskChild in $taskWorkers){if(!$taskChild.HasExited){$taskChild.WaitForExit()}}}
 Write-TaskJson "$taskRoot/FINISHED" @{phase=$taskPhase;atUTC=[DateTimeOffset]::UtcNow.ToString('o')}
 if($taskGuardian -and !$taskGuardian.HasExited){$taskGuardian.WaitForExit()}
 Write-TaskJson "$taskRoot/process-exit-audit.json" @{controllerPID=$PID;workerPIDs=@($taskWorkers|ForEach-Object {$_.Id});allWorkerHandlesExited=(@($taskWorkers|Where-Object {!$_.HasExited}).Count -eq 0);guardianHandleExited=(!$taskGuardian -or $taskGuardian.HasExited);sharedTrainingAwakeRequestNotReleased=$true;atUTC=[DateTimeOffset]::UtcNow.ToString('o')}
 Remove-Item -LiteralPath "$taskRoot/controller.lock"
}
if($taskFailed){exit 1}
