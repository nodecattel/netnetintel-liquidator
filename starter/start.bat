@echo off
setlocal EnableDelayedExpansion
rem Starts, updates or restarts the NetNet Loop liquidator and opens its page. Windows; needs Docker Desktop, running.
rem Your wallet and settings live in the Docker volume "netnet-liq" and survive updates: run this again any time.
rem Exactly one liquidator runs afterwards: every liquidator container here (any name, any version, docker compose
rem copies) is stopped and removed first, so two never race each other. Their storage is never deleted.
set IMAGE=ghcr.io/nodecattel/netnetintel-liquidator:latest
docker info >nul 2>&1 || (echo Open Docker Desktop first, wait until it says it is running, then run this again. Get it at https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
echo Getting the latest liquidator...
docker pull -q %IMAGE% >nul || (pause & exit /b 1)

rem every liquidator container: our label, our image under any tag (kept as started), a compose-built copy, or the usual name
for /f %%i in ('docker ps -aq --no-trunc') do (
  set "hit="
  set "store="
  for /f "tokens=1,2,*" %%a in ('docker inspect -f "{{.Name}} {{.Config.Image}} {{json .Config.Labels}}" %%i 2^>nul') do (
    if /i "%%a"=="/netnet-liq" set hit=1
    echo %%b | findstr /i "netnetintel-liquidator" >nul && set hit=1
    echo %%c | findstr /c:"org.netnetintel.liquidator" >nul && set hit=1
    if defined hit (
      for /f "delims=" %%s in ('docker inspect -f "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" %%i') do set "store=%%s"
      docker rm -f %%i >nul
      if /i "%%a"=="/netnet-liq" if "!store!"=="netnet-liq" (echo Replacing the current liquidator.) else (echo Stopped another liquidator: %%a, storage "!store!". Nothing was deleted; if it used its own wallet, start it alone to withdraw.)
      if /i not "%%a"=="/netnet-liq" echo Stopped another liquidator: %%a, storage "!store!". Nothing was deleted; if it used its own wallet, start it alone to withdraw.
    )
  )
)

rem something outside Docker on the port (a copy started from the source code) would keep running beside this one
curl.exe -fs http://127.0.0.1:8788/api/state >nul 2>&1 && (echo Port 8788 is still in use, probably by a liquidator started from the source code. Stop it, then run this again. & pause & exit /b 1)

rem the page is published to this computer only (127.0.0.1)
docker run -d --name netnet-liq --label org.netnetintel.liquidator=1 --restart unless-stopped -p 127.0.0.1:8788:8788 -v netnet-liq:/data %IMAGE% >nul || (pause & exit /b 1)
echo Starting...
for /l %%i in (1,1,60) do (curl.exe -fs http://127.0.0.1:8788/api/state >nul 2>&1 && goto open & timeout /t 1 >nul)
:open
start http://localhost:8788
echo The liquidator is running, the only one on this computer: http://localhost:8788
echo It keeps running in the background and after restarts. Run this again any time to update it.
pause
