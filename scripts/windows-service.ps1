[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet('install','start','stop','status','uninstall')]
    [string]$Action,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$TaskName = 'omp-web',
    [string]$ConfigDir = (Join-Path $env:APPDATA 'omp-web'),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'omp-web'),
    [string]$BunPath = (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'),
    [string]$OmpPath = (Join-Path $env:USERPROFILE '.bun\bin\omp.exe'),
    [string]$HomeDir,
    [string]$EnvironmentFile,
    [string[]]$DaemonArgs = @()
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runner = Join-Path $PSScriptRoot 'windows-service.ts'
$daemon = Join-Path $repo 'packages\daemon\src\index.ts'
$marker = 'omp-web Windows service v1'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$configDir = [IO.Path]::GetFullPath($ConfigDir)
$stateDir = [IO.Path]::GetFullPath($StateDir)
$serviceConfig = Join-Path $stateDir ("windows-service-$TaskName.json")
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
function Assert-OwnedTask {
    if (-not $task) { throw "Task '$TaskName' is not installed." }
    $xml = [xml](Export-ScheduledTask -TaskName $TaskName -TaskPath '\')
    if ($task.Description -ne $marker -or $xml.Task.Principals.Principal.UserId -ne $sid) {
        throw "Task '$TaskName' is not an omp-web task owned by this user; refusing to change it."
    }
    if (-not $xml.Task.Actions.Exec.Arguments.Contains('"' + $runner + '"')) {
        throw "Task '$TaskName' belongs to another checkout; refusing to change it."
    }
    return $xml
}
function XmlEscape([string]$s) { return [Security.SecurityElement]::Escape($s) }
function QuoteArg([string]$s) {
    if ($s.Contains('"')) { throw 'A path contains a double quote.' }
    return '"' + $s.TrimEnd('\') + ('\' * ($s.Length - $s.TrimEnd('\').Length) * 2) + '"'
}
function Validate-ServiceShell([string]$directory) {
    $file = Join-Path $directory 'config.json'
    if (-not (Test-Path -LiteralPath $file)) { return }
    $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $shell = $settings.terminal.shell
    if (-not $shell) { return }
    $resolved = if ([IO.Path]::IsPathRooted($shell)) { $shell } else { (Get-Command $shell -CommandType Application -ErrorAction Stop).Source }
    if ($resolved -match '(?i)[\\/]WindowsApps[\\/]' -and [IO.Path]::GetFileName($resolved) -match '^(?i:pwsh|powershell)(?:\.exe)?$') {
        throw 'Packaged/AppX pwsh is unsafe in this service: measured PowerShell 7.7 children escape job cleanup. Configure terminal.shell as System32\WindowsPowerShell\v1.0\powershell.exe, or a nonpackaged shell whose cleanup is verified.'
    }
}
function Stop-OwnedTask {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $roots = @($scheduler.GetRunningTasks(0) | Where-Object { $_.Path -eq ('\' + $TaskName) } | ForEach-Object { [int]$_.EnginePID })
    $all = @(Get-CimInstance Win32_Process)
    $tree = @($all | Where-Object { $_.ProcessId -in $roots })
    do {
        $children = @($all | Where-Object { $_.ParentProcessId -in @($tree.ProcessId) -and $_.ProcessId -notin @($tree.ProcessId) })
        $tree += $children
    } while ($children.Count)
    Stop-ScheduledTask -TaskName $TaskName -TaskPath '\'
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $remaining = @($tree | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        if (-not $remaining.Count) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Task stopped but recorded descendants remain: $($remaining.ProcessId -join ', ')"
}
if ($Action -eq 'install') {
    if ($task) { throw "Task '$TaskName' already exists; no task was overwritten." }
    foreach ($path in @($BunPath, $OmpPath, $runner, $daemon)) {
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "File not found or not absolute: $path" }
    }
    if ($HomeDir) { $HomeDir = [IO.Path]::GetFullPath($HomeDir) }
    if ($EnvironmentFile) {
        $EnvironmentFile = [IO.Path]::GetFullPath($EnvironmentFile)
        if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) { throw "Environment file not found: $EnvironmentFile" }
    }
    Validate-ServiceShell $configDir
    $valueFlags = @('--role','--name','--session-dir','--bind','--port','--web-dir','--allow-origin','--gateway-url','--credential-file','--broker-bind','--broker-home','--broker-advertise-url','--broker-url','--broker-token-file')
    $switchFlags = @('--broker','--terminal')
    for ($i=0; $i -lt $DaemonArgs.Count; $i++) {
        $flag = $DaemonArgs[$i]
        if ($flag -in $switchFlags) { continue }
        if ($flag -notin $valueFlags -or ++$i -ge $DaemonArgs.Count) { throw "Unsupported flag or missing value: $flag" }
        $value = $DaemonArgs[$i]
        if ($value.StartsWith('--')) { throw "Missing value for $flag" }
        if ($flag -in @('--gateway-url','--broker-url','--broker-advertise-url')) {
            $uri = [Uri]$value
            if (-not $uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw "URL for $flag must not contain credentials, query or fragment." }
        }
    }
    if (-not (Test-Path -LiteralPath $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
        & icacls.exe $stateDir /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not protect $stateDir" }
    }
    if (Test-Path -LiteralPath $serviceConfig) { throw "Service configuration already exists: $serviceConfig" }
    $cfg = @{ bun=[IO.Path]::GetFullPath($BunPath); omp=[IO.Path]::GetFullPath($OmpPath); repo=$repo; configDir=$configDir; stateDir=$stateDir; args=@($DaemonArgs); home=$HomeDir; environmentFile=$EnvironmentFile }
    $cfg | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $serviceConfig -Encoding UTF8
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    $arguments = '--headless ' + (QuoteArg $cfg.bun) + ' ' + (QuoteArg $runner) + ' ' + (QuoteArg $serviceConfig)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>$(XmlEscape $marker)</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$(XmlEscape $user)</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>$(XmlEscape $sid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>6</Priority></Settings>
<Actions Context="Author"><Exec><Command>$(XmlEscape $conhost)</Command><Arguments>$(XmlEscape $arguments)</Arguments><WorkingDirectory>$(XmlEscape $repo)</WorkingDirectory></Exec></Actions>
</Task>
"@
    try { Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Xml $xml -ErrorAction Stop | Out-Null }
    catch {
        $registrationError = $_
        Remove-Item -LiteralPath $serviceConfig -Force
        throw "Failed to register task '$TaskName': $registrationError. Run Windows PowerShell as administrator, or use the Startup folder instead (see README.md)."
    }
    Write-Output "Installed '$TaskName' for $user. Start it with: .\scripts\windows-service.ps1 start -TaskName $TaskName"
} else {
    $xml = Assert-OwnedTask
    switch ($Action) {
        'start' {
            $match = [regex]::Match($xml.Task.Actions.Exec.Arguments, '"([^"]*windows-service-[^"]+\.json)"')
            if (-not $match.Success) { throw 'Cannot locate the task service configuration.' }
            $stored = Get-Content -LiteralPath $match.Groups[1].Value -Raw | ConvertFrom-Json
            Validate-ServiceShell $stored.configDir
            Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
            Write-Output "Started '$TaskName'."
        }
        'stop' { Stop-OwnedTask; Write-Output "Stopped '$TaskName'; recorded process tree exited." }
        'status' {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\'
            Write-Output "Scheduler: $($task.State); last result: $($info.LastTaskResult)"
            $match = [regex]::Match($xml.Task.Actions.Exec.Arguments, '"([^"]*windows-service-[^"]+\.json)"')
            if ($match.Success) {
                $stored = Get-Content -LiteralPath $match.Groups[1].Value -Raw | ConvertFrom-Json
                $statusPath = Join-Path $stored.stateDir 'windows-service-status.json'
                if (Test-Path -LiteralPath $statusPath) {
                    $s = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
                    $runnerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$s.runnerPid)" -ErrorAction SilentlyContinue
                    $identityMatches = $runnerProcess -and $runnerProcess.CommandLine.Contains($runner) -and $runnerProcess.CommandLine.Contains($match.Groups[1].Value) -and [Math]::Abs(([DateTimeOffset]$runnerProcess.CreationDate).ToUnixTimeMilliseconds() - [long]$s.runnerStartedAt) -lt 5000
                    if ($task.State -eq 'Running' -and $identityMatches) {
                        if ($s.daemonPid -and -not (Get-Process -Id $s.daemonPid -ErrorAction SilentlyContinue)) { $s.phase = 'daemon-exited' }
                        Write-Output "Runner: $($s.runnerPid); daemon: $($s.daemonPid); phase: $($s.phase); restarts: $($s.restarts); last exit: $($s.exitCode); updated: $($s.updatedAt)"
                    } else { Write-Output 'Runner is not verified alive; status file is stale.' }
                } else { Write-Output 'Runner has not written status yet.' }
            }
        }
        'uninstall' {
            if ($task.State -eq 'Running') { Stop-OwnedTask }
            Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
            $match = [regex]::Match($xml.Task.Actions.Exec.Arguments, '"([^"]*windows-service-[^"]+\.json)"')
            if ($match.Success) { Remove-Item -LiteralPath $match.Groups[1].Value -Force -ErrorAction SilentlyContinue }
            Write-Output "Uninstalled '$TaskName'; configuration and state directories were preserved."
        }
    }
}
