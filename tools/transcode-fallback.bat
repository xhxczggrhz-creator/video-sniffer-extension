@echo off
chcp 65001 >nul
setlocal
:: ============================================================
:: 转码兜底修复（慢，仅给「新建 文本文档.bat」修不好的文件用）
:: 注意：原版脚本的 if !errorlevel! neq 0 在未开延迟展开时
:: 恒为真，会把每个成功产物误删——本版已修复。
:: ============================================================

:: ================== 可调参数 ==================
:: 广告时长（秒）：从该处开始保留正片；设 0 表示不切广告
set "AD_SECS=19"
:: ffmpeg 路径：优先用本目录下的 ffmpeg.exe
set "FF=%~dp0ffmpeg.exe"
if not exist "%FF%" set "FF=ffmpeg"
:: 转码参数：CRF 越低画质越好（18~28 常用）；preset 越慢体积越小
set "CRF=23"
set "PRESET=fast"
:: ==============================================

if not exist "%FF%" (
    echo 错误：找不到 ffmpeg.exe，请把它和本脚本放在同一目录
    pause
    exit /b 1
)

if not exist "修复完成_转码" md "修复完成_转码"
set /a OKCOUNT=0
set /a FAILCOUNT=0

for %%i in (*.mp4 *.ts *.mkv) do (
    echo.
    echo 正在转码处理：%%i
    "%FF%" -hide_banner -loglevel error -stats -y -ss %AD_SECS% -i "%%i" -c:v libx264 -crf %CRF% -preset %PRESET% -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "修复完成_转码\%%~ni.mp4"
    if errorlevel 1 (
        echo ----------转码失败：%%i----------
        del "修复完成_转码\%%~ni.mp4" 2>nul
        set /a FAILCOUNT+=1
    ) else (
        set /a OKCOUNT+=1
    )
)

echo.
echo ================================================
echo 转码任务结束！成功 %OKCOUNT% 个，失败 %FAILCOUNT% 个
echo 输出目录：「修复完成_转码」文件夹
echo ================================================
pause
