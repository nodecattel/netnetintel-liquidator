@echo off
rem Starts (or updates) the NetNet Loop liquidator and opens its page. Windows; needs Docker Desktop, running.
rem Your wallet and settings live in the Docker volume "netnet-liq" and survive updates: run this again any time.
set IMAGE=ghcr.io/nodecattel/netnetintel-liquidator:latest
docker info >nul 2>&1 || (echo Open Docker Desktop first, wait until it says it is running, then run this again. Get it at https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
echo Getting the latest liquidator...
docker pull -q %IMAGE% >nul || (pause & exit /b 1)
docker rm -f netnet-liq >nul 2>&1
rem the page is published to this computer only (127.0.0.1)
docker run -d --name netnet-liq --restart unless-stopped -p 127.0.0.1:8788:8788 -v netnet-liq:/data %IMAGE% >nul || (pause & exit /b 1)
echo Starting...
for /l %%i in (1,1,60) do (curl.exe -fs http://127.0.0.1:8788/api/state >nul 2>&1 && goto open & timeout /t 1 >nul)
:open
start http://localhost:8788
echo The liquidator is running: http://localhost:8788
echo It keeps running in the background and after restarts. Run this again any time to update it.
pause
