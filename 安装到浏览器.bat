@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%extension\manifest.json" (
  echo [閿欒] 鎵句笉鍒?extension\manifest.json
  echo 璇锋妸鏈剼鏈斁鍦?LinkDrag 鏂囦欢澶规牴閮ㄣ€?  pause
  exit /b 1
)
echo ============================================================
echo   LinkDrag - 娴忚鍣ㄦ墿灞曞畨瑁呭姪鎵?echo ============================================================
echo.
echo 鎺ヤ笅鏉ユ祻瑙堝櫒鍙兘鑷姩鎵撳紑鎵╁睍绠＄悊椤碉紱濡傛灉娌℃湁锛岃鎵嬪姩鎵撳紑锛?echo   Edge:   edge://extensions
echo   Chrome: chrome://extensions
echo.
echo 鍦ㄦ墿灞曠鐞嗛〉锛?echo   1. 鎵撳紑鍙充笂瑙掋€屽紑鍙戜汉鍛樻ā寮忋€?echo   2. 鐐瑰嚮銆屽姞杞借В鍘嬬缉鐨勬墿灞曘€?echo   3. 閫夋嫨涓嬮潰鎵撳紑鐨勮繖涓?extension 鏂囦欢澶癸細
echo      %ROOT%extension
echo.
echo 绗竴娆″畨瑁呬細鎵撳紑銆岄€夐」涓庤瘖鏂€嶉〉锛岃鏄庢潈闄愪笌鐢ㄦ硶銆?echo.
start "" explorer.exe "%ROOT%extension"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "edge://extensions/"
  goto done
)
set "EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE2%" (
  start "" "%EDGE2%" "edge://extensions/"
  goto done
)
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" "chrome://extensions/"
  goto done
)
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME2%" (
  start "" "%CHROME2%" "chrome://extensions/"
  goto done
)
echo 鏈壘鍒?Edge / Chrome 鐨勯粯璁ゅ畨瑁呰矾寰勶紝璇锋墜鍔ㄦ墦寮€鎵╁睍绠＄悊椤点€?:done
echo.
echo 瀹夎瀹屾垚鍚庯紝鎵撳紑浠绘剰鏅€氱綉椤靛嵆鍙娇鐢ㄣ€?pause

