#!/usr/bin/env pwsh

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
[string]$LinuxPwshCommand = "pwsh"
[string]$WindowsPwshCommand = "pwsh.exe"
[bool]$KillExistingChrome = $false
[bool]$ForceMode = $false
[int]$RemoteDebuggingPort = 9222
[string]$RemoteDebuggingAddress = "0.0.0.0"
[string]$RequestedProfile = "mwodevelop"
[string]$PwshMode = $null

function Get-PwshModeFromRawArguments {
    param([string[]]$AllArguments)

    for ($idx = 0; $idx -lt $AllArguments.Count; $idx++) {
        $CurrentArg = [string]$AllArguments[$idx]

        if ($CurrentArg -eq '--pwsh') {
            if ($idx + 1 -ge $AllArguments.Count) {
                return $null
            }

            return ([string]$AllArguments[$idx + 1]).Trim().ToLowerInvariant()
        }

        if ($CurrentArg.StartsWith('--pwsh=')) {
            return $CurrentArg.Substring('--pwsh='.Length).Trim().ToLowerInvariant()
        }
    }

    return $null
}

function Test-HelpRequested {
    param([string[]]$AllArguments)

    foreach ($CurrentArg in $AllArguments) {
        if ($CurrentArg -in @('--help', '-h', '/?')) {
            return $true
        }
    }

    return $false
}

function Test-WslInteropAvailable {
    $InteropHandlerPaths = @(
        '/proc/sys/fs/binfmt_misc/WSLInterop',
        '/proc/sys/fs/binfmt_misc/WSLInterop-late'
    )

    foreach ($InteropHandlerPath in $InteropHandlerPaths) {
        if (-not (Test-Path $InteropHandlerPath)) {
            continue
        }

        try {
            $InteropHandler = Get-Content -Path $InteropHandlerPath -Raw -ErrorAction Stop
        }
        catch {
            continue
        }

        if ($InteropHandler -match '(?m)^enabled\s*$' -and $InteropHandler -match '(?m)^interpreter /init\s*$') {
            return $true
        }
    }

    return $false
}

function Get-ForwardArgumentsForWindows {
    param([string[]]$AllArguments)

    $ForwardArguments = @()

    for ($idx = 0; $idx -lt $AllArguments.Count; $idx++) {
        $CurrentArg = [string]$AllArguments[$idx]

        if ($CurrentArg -eq '--pwsh') {
            if ($idx + 1 -ge $AllArguments.Count) {
                Write-Error "Brakuje wartosci dla opcji --pwsh"
                exit 1
            }

            $ForwardArguments += '--pwsh'
            $ForwardArguments += 'windows'
            $idx++
            continue
        }

        if ($CurrentArg.StartsWith('--pwsh=')) {
            $ForwardArguments += '--pwsh=windows'
            continue
        }

        $ForwardArguments += $CurrentArg
    }

    return ,$ForwardArguments
}

function Show-Usage {
    Write-Host @'
Uzycie:
  .\start-chrome-mwodevelop.ps1 --pwsh <linux|windows> [--profile <login_google>] [--port <numer_portu>] [--force] [-KillExistingChrome] [-RemoteDebuggingAddress <address>]

Przyklady:
  .\start-chrome-mwodevelop.ps1 --pwsh windows --profile mwodevelop
  .\start-chrome-mwodevelop.ps1 --pwsh windows --profile mwodevelop@gmail.com -KillExistingChrome
  .\start-chrome-mwodevelop.ps1 --pwsh windows --profile mwodevelop --port 9333
  .\start-chrome-mwodevelop.ps1 --pwsh windows --profile mwodevelop --force

Przyklady wywolania przez pwsh (WSL/Linux):
  pwsh -NoProfile -ExecutionPolicy Bypass -File '/home/mwo/projects/docker-steam-headless/start-chrome-mwodevelop.ps1' --pwsh linux -KillExistingChrome

Przyklady wywolania przez pwsh.exe (Windows):
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<nazwa_uzytkownika>\projects\docker-steam-headless\start-chrome-mwodevelop.ps1" --pwsh windows -KillExistingChrome

Przyklad wywolania pwsh.exe z WSL (konwersja sciezki):
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w '/home/mwo/projects/docker-steam-headless/start-chrome-mwodevelop.ps1')" --pwsh windows -KillExistingChrome

Domyslne wartosci:
  --pwsh (obowiazkowe): linux lub windows
  --profile mwodevelop
  --port 9222
  --address 0.0.0.0
'@
}

$IsWindowsPlatform = $env:OS -eq 'Windows_NT'
$IsWslEnvironment = (-not $IsWindowsPlatform) -and (
    -not [string]::IsNullOrWhiteSpace($env:WSL_DISTRO_NAME) -or
    (Test-Path '/proc/sys/fs/binfmt_misc/WSLInterop')
)

$IsHelpRequested = Test-HelpRequested -AllArguments $args
$PwshModeFromRawArguments = Get-PwshModeFromRawArguments -AllArguments $args

if (-not $IsHelpRequested -and [string]::IsNullOrWhiteSpace($PwshModeFromRawArguments)) {
    Write-Error "Opcja --pwsh [linux|windows] jest wymagana."
    Show-Usage
    exit 1
}

if (-not [string]::IsNullOrWhiteSpace($PwshModeFromRawArguments) -and $PwshModeFromRawArguments -notin @('linux', 'windows')) {
    Write-Error "Nieprawidlowa wartosc opcji --pwsh: $PwshModeFromRawArguments. Dozwolone: linux albo windows."
    Show-Usage
    exit 1
}

$PwshMode = $PwshModeFromRawArguments

if ($IsWslEnvironment) {
    if (-not $IsHelpRequested -and $PwshMode -ne 'linux') {
        Write-Error "W WSL uruchamiaj skrypt z: --pwsh linux"
        exit 1
    }

    if (-not (Test-WslInteropAvailable)) {
        Write-Error @'
WSL Interop jest nieaktywny, dlatego nie mozna uruchomic Windows pwsh.exe ani Chrome z tej sesji WSL.
W PowerShell lub cmd po stronie Windows uruchom: wsl --shutdown
Nastepnie otworz nowa sesje WSL i uruchom skrypt ponownie.
Jesli problem powroci, sprawdz, czy /etc/wsl.conf nie zawiera [interop] enabled=false.
'@
        exit 1
    }

    $WindowsPwsh = (Get-Command $WindowsPwshCommand -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)

    if (-not $WindowsPwsh) {
        Write-Error "Wykryto WSL, ale nie znaleziono $WindowsPwshCommand po stronie Windows. Zainstaluj PowerShell 7 na Windows albo uruchom skrypt przez powershell.exe."
        exit 1
    }

    $WindowsScriptPath = (& wslpath -w $PSCommandPath 2>$null)

    if ([string]::IsNullOrWhiteSpace($WindowsScriptPath)) {
        Write-Error "Nie udalo sie przetlumaczyc sciezki skryptu na format Windows: $PSCommandPath"
        exit 1
    }

    $ForwardArguments = Get-ForwardArgumentsForWindows -AllArguments $args

    Write-Host "[INFO] Wykryto uruchomienie w WSL przez $LinuxPwshCommand. Przekierowuje wykonanie do Windows $WindowsPwshCommand..."
    & $WindowsPwsh -NoProfile -ExecutionPolicy Bypass -File $WindowsScriptPath @ForwardArguments
    exit $LASTEXITCODE
}

if ($IsWindowsPlatform -and -not $IsHelpRequested -and $PwshMode -ne 'windows') {
    Write-Error "W Windows uruchamiaj skrypt z: --pwsh windows"
    exit 1
}

function Get-NextArgumentValue {
    param(
        [string[]]$AllArguments,
        [int]$CurrentIndex,
        [string]$OptionName
    )

    if ($CurrentIndex + 1 -ge $AllArguments.Count) {
        Write-Error "Brakuje wartosci dla opcji $OptionName"
        exit 1
    }

    return [string]$AllArguments[$CurrentIndex + 1]
}

function Normalize-Value {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    return $Value.Trim().ToLowerInvariant()
}

function Get-SafePathComponent {
    param([AllowNull()][string]$Value)

    $Normalized = Normalize-Value $Value
    if (-not $Normalized) {
        return "profile"
    }

    $SafeValue = [regex]::Replace($Normalized, '[^a-z0-9._-]', '-')
    $SafeValue = $SafeValue.Trim('-')

    if ([string]::IsNullOrWhiteSpace($SafeValue)) {
        return "profile"
    }

    return $SafeValue
}

function Test-RemoteDebuggingPortWithNetstat {
    param(
        [int]$Port,
        [int]$MaxAttempts = 20,
        [int]$DelaySeconds = 1
    )

    $Pattern = ":$Port\s"

    for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt++) {
        $NetstatLines = netstat -ano | Select-String -Pattern 'LISTENING' | Select-String -Pattern $Pattern

        if ($NetstatLines) {
            Write-Host "[OK] Wykryto nasluchiwanie na porcie $Port (proba $Attempt/$MaxAttempts)."
            Write-Host "[netstat]"
            $NetstatLines | ForEach-Object { Write-Host $_.Line }
            return $true
        }

        Start-Sleep -Seconds $DelaySeconds
    }

    Write-Host "[ERROR] Nie wykryto nasluchiwania na porcie $Port po $MaxAttempts probach."
    Write-Host "[netstat] Brak wpisu LISTENING dla portu $Port"
    return $false
}

function Get-ChromeProcesses {
    return @(Get-Process -Name chrome -ErrorAction SilentlyContinue)
}

function Stop-ChromeProcesses {
    $RunningChrome = @(Get-ChromeProcesses)

    if ($RunningChrome.Count -eq 0) {
        return
    }

    Write-Host "Zamykanie uruchomionych procesow Chrome..."
    Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

function Get-FreeTcpPort {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $Listener.Start()
    $Port = ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
    $Listener.Stop()
    return $Port
}

function Get-ListeningProcessIdsByPort {
    param([int]$Port)

    $PortRegex = [regex]":$Port\s"
    $Pids = @()

    foreach ($Entry in (netstat -ano | Select-String -Pattern 'LISTENING')) {
        if (-not $PortRegex.IsMatch($Entry.Line)) {
            continue
        }

        $PidMatch = [regex]::Match($Entry.Line, 'LISTENING\s+(\d+)\s*$')
        if ($PidMatch.Success) {
            $Pids += [int]$PidMatch.Groups[1].Value
        }
    }

    return @($Pids | Sort-Object -Unique)
}

function Stop-ProcessesListeningOnPort {
    param([int]$Port)

    $ListeningProcessIds = @(Get-ListeningProcessIdsByPort -Port $Port)

    if ($ListeningProcessIds.Count -eq 0) {
        Write-Host "[FORCE] Port $Port jest wolny."
        return
    }

    Write-Host "[FORCE] Port $Port jest zajety przez PID: $($ListeningProcessIds -join ', ')"

    foreach ($ProcessIdToStop in $ListeningProcessIds) {
        try {
            Stop-Process -Id $ProcessIdToStop -Force -ErrorAction Stop
            Write-Host "[FORCE] Zakonczono proces PID=$ProcessIdToStop"
        } catch {
            Write-Host "[WARN] Stop-Process nie udal sie dla PID=$ProcessIdToStop, probuje taskkill"
            cmd /c "taskkill /PID $ProcessIdToStop /F" | Out-Host
        }
    }

    Start-Sleep -Seconds 1
}

function Test-RemoteDebuggingHttpEndpoint {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 5,
        [int]$MaxAttempts = 12,
        [int]$DelaySeconds = 1
    )

    $Url = "http://127.0.0.1:$Port/json/version"

    for ($Attempt = 1; $Attempt -le $MaxAttempts; $Attempt++) {
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
            Write-Host "[OK] Endpoint DevTools odpowiada: $Url (HTTP $($Response.StatusCode), proba $Attempt/$MaxAttempts)"
            return $true
        } catch {
            if ($Attempt -eq $MaxAttempts) {
                Write-Host "[ERROR] Endpoint DevTools nie odpowiada: $Url"
                Write-Host "[ERROR] $($_.Exception.Message)"
                return $false
            }

            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

function Start-RemoteDebuggingProxy {
    param(
        [string]$ListenAddress,
        [int]$ListenPort,
        [string]$ConnectAddress,
        [int]$ConnectPort
    )

    $ProxyScriptPath = Join-Path $env:TEMP ("chrome-cdp-proxy-{0}.ps1" -f $ListenPort)

    $PowerShellExe = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path $PowerShellExe)) {
        $PowerShellExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    }
    if (-not $PowerShellExe) {
        $PowerShellExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    }
    if (-not $PowerShellExe) {
        Write-Error "Nie znaleziono ani pwsh.exe, ani powershell.exe do uruchomienia proxy CDP."
        exit 1
    }

    $ProxyScript = @"
param(
    [string]`$ListenAddress,
    [int]`$ListenPort,
    [string]`$ConnectAddress,
    [int]`$ConnectPort
)

`$ErrorActionPreference = 'Stop'

function Get-ListenIp {
    param([string]`$Address)

    if (`$Address -eq '0.0.0.0') {
        return [System.Net.IPAddress]::Any
    }

    if (`$Address -eq '127.0.0.1') {
        return [System.Net.IPAddress]::Loopback
    }

    return [System.Net.IPAddress]::Parse(`$Address)
}

`$Listener = [System.Net.Sockets.TcpListener]::new((Get-ListenIp -Address `$ListenAddress), `$ListenPort)
`$Listener.Start()

while (`$true) {
    `$Client = `$Listener.AcceptTcpClient()

    [System.Threading.Tasks.Task]::Run([Action]{
        `$Upstream = [System.Net.Sockets.TcpClient]::new()
        try {
            `$Upstream.Connect(`$ConnectAddress, `$ConnectPort)
            `$ClientStream = `$Client.GetStream()
            `$UpstreamStream = `$Upstream.GetStream()
            `$Task1 = `$ClientStream.CopyToAsync(`$UpstreamStream)
            `$Task2 = `$UpstreamStream.CopyToAsync(`$ClientStream)
            [System.Threading.Tasks.Task]::WaitAny(@(`$Task1, `$Task2)) | Out-Null
        } catch {
        } finally {
            try { `$Client.Close() } catch {}
            try { `$Upstream.Close() } catch {}
        }
    }) | Out-Null
}
"@

    Set-Content -Path $ProxyScriptPath -Value $ProxyScript -Encoding ASCII

    $Process = Start-Process -FilePath $PowerShellExe -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $ProxyScriptPath,
        '-ListenAddress', $ListenAddress,
        '-ListenPort', $ListenPort,
        '-ConnectAddress', $ConnectAddress,
        '-ConnectPort', $ConnectPort
    )

    Write-Host "[INFO] Uruchomiono proxy CDP PID=$($Process.Id): ${ListenAddress}:$ListenPort -> ${ConnectAddress}:$ConnectPort"
    return $Process
}

function Sync-ProfileToIsolatedUserDataDir {
    param(
        [string]$SourceUserDataDir,
        [string]$SourceProfileDirectory,
        [string]$TargetUserDataDir
    )

    $SourceProfileDir = Join-Path $SourceUserDataDir $SourceProfileDirectory
    $TargetProfileDir = Join-Path $TargetUserDataDir $SourceProfileDirectory
    $SourceLocalState = Join-Path $SourceUserDataDir "Local State"
    $TargetLocalState = Join-Path $TargetUserDataDir "Local State"

    if (-not (Test-Path $SourceProfileDir)) {
        Write-Error "Nie znaleziono katalogu zrodlowego profilu: $SourceProfileDir"
        exit 1
    }

    New-Item -ItemType Directory -Path $TargetUserDataDir -Force | Out-Null
    Copy-Item -Path $SourceLocalState -Destination $TargetLocalState -Force

    Write-Host "[INFO] Synchronizuje profil do izolowanego katalogu danych Chrome..."
    Write-Host "[INFO] Zrodlo: $SourceProfileDir"
    Write-Host "[INFO] Cel:    $TargetProfileDir"

    $RoboCopyArgs = @(
        $SourceProfileDir,
        $TargetProfileDir,
        '/MIR',
        '/FFT',
        '/R:1',
        '/W:1',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
        '/XF',
        'LOCK',
        'SingletonLock',
        'SingletonSocket',
        'SingletonCookie',
        'DevToolsActivePort'
    )

    & robocopy @RoboCopyArgs | Out-Host
    $RoboCopyExitCode = $LASTEXITCODE

    if ($RoboCopyExitCode -gt 7) {
        Write-Error "Robocopy zakonczyl sie bledem. Kod wyjscia: $RoboCopyExitCode"
        exit 1
    }

    @(
        (Join-Path $TargetUserDataDir 'SingletonLock'),
        (Join-Path $TargetUserDataDir 'SingletonSocket'),
        (Join-Path $TargetUserDataDir 'SingletonCookie'),
        (Join-Path $TargetProfileDir 'LOCK'),
        (Join-Path $TargetProfileDir 'DevToolsActivePort')
    ) | ForEach-Object {
        Remove-Item -Path $_ -Force -ErrorAction SilentlyContinue
    }
}

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]

    if ($arg -in @('--help', '-h', '/?')) {
        Show-Usage
        exit 0
    }

    if ($arg -eq '--pwsh') {
        $PwshMode = Get-NextArgumentValue -AllArguments $args -CurrentIndex $i -OptionName '--pwsh'
        $i++
        continue
    }

    if ($arg.StartsWith('--pwsh=')) {
        $PwshMode = $arg.Substring('--pwsh='.Length)
        continue
    }

    if ($arg -eq '--profile') {
        $RequestedProfile = Get-NextArgumentValue -AllArguments $args -CurrentIndex $i -OptionName '--profile'
        $i++
        continue
    }

    if ($arg.StartsWith('--profile=')) {
        $RequestedProfile = $arg.Substring('--profile='.Length)
        continue
    }

    if ($arg -in @('-KillExistingChrome', '--kill-existing-chrome')) {
        $KillExistingChrome = $true
        continue
    }

    if ($arg -in @('--force', '-Force')) {
        $ForceMode = $true
        continue
    }

    if ($arg -in @('-RemoteDebuggingPort', '--port')) {
        $portValue = Get-NextArgumentValue -AllArguments $args -CurrentIndex $i -OptionName $arg
        [int]$parsedPort = 0
        if (-not [int]::TryParse($portValue, [ref]$parsedPort)) {
            Write-Error "Nieprawidlowy port: $portValue"
            exit 1
        }
        $RemoteDebuggingPort = $parsedPort
        $i++
        continue
    }

    if ($arg.StartsWith('--port=')) {
        $portValue = $arg.Substring('--port='.Length)
        [int]$parsedPort = 0
        if (-not [int]::TryParse($portValue, [ref]$parsedPort)) {
            Write-Error "Nieprawidlowy port: $portValue"
            exit 1
        }
        $RemoteDebuggingPort = $parsedPort
        continue
    }

    if ($arg -in @('-RemoteDebuggingAddress', '--address')) {
        $RemoteDebuggingAddress = Get-NextArgumentValue -AllArguments $args -CurrentIndex $i -OptionName $arg
        $i++
        continue
    }

    if ($arg.StartsWith('--address=')) {
        $RemoteDebuggingAddress = $arg.Substring('--address='.Length)
        continue
    }

    Write-Error "Nieznany argument: $arg"
    Show-Usage
    exit 1
}

if (-not $env:LOCALAPPDATA) {
    Write-Error "Brak zmiennej LOCALAPPDATA. Uruchom skrypt w normalnej sesji Windows PowerShell / PowerShell."
    exit 1
}

$SourceUserDataDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$SourceLocalStatePath = Join-Path $SourceUserDataDir "Local State"

if (-not (Test-Path $ChromePath)) {
    Write-Error "Nie znaleziono Chrome pod sciezka: $ChromePath"
    exit 1
}

if (-not (Test-Path $SourceUserDataDir)) {
    Write-Error "Nie znaleziono katalogu danych Chrome: $SourceUserDataDir"
    exit 1
}

if (-not (Test-Path $SourceLocalStatePath)) {
    Write-Error "Nie znaleziono pliku z profilami Chrome: $SourceLocalStatePath"
    exit 1
}

$LocalState = Get-Content -Path $SourceLocalStatePath -Raw | ConvertFrom-Json
$ProfileInfoCache = $LocalState.profile.info_cache

if (-not $ProfileInfoCache) {
    Write-Error "Nie udalo sie odczytac listy profili Chrome z pliku Local State."
    exit 1
}

$AvailableProfiles = @(
    $ProfileInfoCache.PSObject.Properties | ForEach-Object {
        $Info = $_.Value
        $Email = [string]$Info.user_name
        $Alias = $null

        if ($Email -and $Email.Contains('@')) {
            $Alias = $Email.Split('@')[0].ToLowerInvariant()
        }

        [PSCustomObject]@{
            ProfileDirectory  = $_.Name
            Email             = $Email
            EmailNormalized   = Normalize-Value $Email
            Alias             = $Alias
            DisplayName       = [string]$Info.name
            DisplayNormalized = Normalize-Value ([string]$Info.name)
        }
    }
)

$RequestedProfileNormalized = Normalize-Value $RequestedProfile

$MatchingProfiles = @(
    $AvailableProfiles | Where-Object {
        $_.EmailNormalized -eq $RequestedProfileNormalized -or
        $_.Alias -eq $RequestedProfileNormalized -or
        $_.DisplayNormalized -eq $RequestedProfileNormalized -or
        (Normalize-Value $_.ProfileDirectory) -eq $RequestedProfileNormalized
    }
)

if ($MatchingProfiles.Count -eq 0) {
    $AvailableAliases = $AvailableProfiles |
        Where-Object { $_.Email } |
        ForEach-Object { "- {0} -> {1} ({2})" -f $_.Alias, $_.Email, $_.ProfileDirectory }

    Write-Error @"
Nie znalazlem profilu dla selektora: $RequestedProfile

Dostepne profile:
$($AvailableAliases -join [Environment]::NewLine)
"@
    exit 1
}

if ($MatchingProfiles.Count -gt 1) {
    $MatchesDescription = $MatchingProfiles |
        ForEach-Object { "- {0} ({1})" -f $_.Email, $_.ProfileDirectory }

    Write-Error @"
Selektor '$RequestedProfile' pasuje do wiecej niz jednego profilu:
$($MatchesDescription -join [Environment]::NewLine)

Podaj pelny email albo dokladny katalog profilu Chrome.
"@
    exit 1
}

$SelectedProfile = $MatchingProfiles[0]
$RuntimeProfileKey = if ($SelectedProfile.Alias) { $SelectedProfile.Alias } elseif ($SelectedProfile.Email) { $SelectedProfile.Email } else { $SelectedProfile.ProfileDirectory }
$RuntimeUserDataDir = Join-Path $env:LOCALAPPDATA ("chrome-mcp\" + (Get-SafePathComponent $RuntimeProfileKey))
$ChromeRemoteDebuggingAddress = $RemoteDebuggingAddress
$ChromeRemoteDebuggingPort = $RemoteDebuggingPort

if ($ForceMode) {
    Write-Host "[FORCE] Wlaczono tryb force. Zwalniam port $RemoteDebuggingPort i zatrzymuje procesy Chrome."
    Stop-ProcessesListeningOnPort -Port $RemoteDebuggingPort

    $RunningChrome = @(Get-ChromeProcesses)
    if ($RunningChrome.Count -gt 0) {
        Write-Host "[FORCE] Zatrzymuje uruchomione procesy Chrome: $($RunningChrome.Count)"
        Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    $KillExistingChrome = $false
}

$ChromeProcessesBeforeStart = @(Get-ChromeProcesses)

if ($ChromeProcessesBeforeStart.Count -gt 0 -and -not $KillExistingChrome) {
    Write-Host "[WARN] Wykryto juz uruchomione procesy Chrome: $($ChromeProcessesBeforeStart.Count)"
    Write-Host "[WARN] Aktywna sesja Chrome blokuje pliki profilu potrzebne do synchronizacji izolowanego katalogu danych."
    Write-Host "[WARN] Automatycznie wlaczam zachowanie jak dla opcji -KillExistingChrome, zeby uniknac bledow robocopy i timeoutow DevTools."
    $KillExistingChrome = $true
}

if ($KillExistingChrome) {
    Stop-ChromeProcesses
}

Write-Host "[INFO] Wybrany profil: $($SelectedProfile.ProfileDirectory)"
Write-Host "[INFO] Wybrane konto:  $($SelectedProfile.Email)"
Write-Host "[INFO] Chrome 136+ potrafi ignorowac remote debugging dla glownego katalogu User Data."
Write-Host "[INFO] Uzywam izolowanego katalogu danych: $RuntimeUserDataDir"
Write-Host "[INFO] Chrome wystawi CDP bezposrednio na ${ChromeRemoteDebuggingAddress}:$ChromeRemoteDebuggingPort"

Sync-ProfileToIsolatedUserDataDir -SourceUserDataDir $SourceUserDataDir -SourceProfileDirectory $SelectedProfile.ProfileDirectory -TargetUserDataDir $RuntimeUserDataDir

$Arguments = @(
    "--remote-debugging-port=$ChromeRemoteDebuggingPort",
    "--remote-debugging-address=$ChromeRemoteDebuggingAddress",
    "--user-data-dir=`"$RuntimeUserDataDir`"",
    "--profile-directory=`"$($SelectedProfile.ProfileDirectory)`"",
    "--no-first-run",
    "--no-default-browser-check"
)

Write-Host "Uruchamianie Chrome dla konta $($SelectedProfile.Email) na profilu $($SelectedProfile.ProfileDirectory)..."

$StartedProcess = Start-Process -FilePath $ChromePath -ArgumentList $Arguments -PassThru
Write-Host "[INFO] Uruchomiono proces startowy Chrome PID=$($StartedProcess.Id)"

$Listening = Test-RemoteDebuggingPortWithNetstat -Port $RemoteDebuggingPort

if (-not $Listening) {
    $ChromeProcessesAfterStart = @(Get-ChromeProcesses)
    Write-Host "[INFO] Aktualna liczba procesow Chrome: $($ChromeProcessesAfterStart.Count)"
    Write-Host "[SUGESTIA] Sprobuj ponownie z: -KillExistingChrome"
    Write-Host "[SUGESTIA] Jesli nadal nie zadziala, sprawdz recznie: netstat -ano | findstr :$RemoteDebuggingPort"
    exit 1
}

$HttpOk = Test-RemoteDebuggingHttpEndpoint -Port $RemoteDebuggingPort

if (-not $HttpOk) {
    exit 1
}
