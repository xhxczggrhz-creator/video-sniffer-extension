@echo off
chcp 65001 >nul
setlocal
:: ============================================================
:: 坏视频快速修复（秒级、零转码、零画质损失）
:: 原理：坏文件的样本时长表含 ≈2^32 的巨大条目（广告+正片 PTS
:: 各自从 0 起所致），直接 -c copy 会让 ffmpeg 报
:: "Application provided duration: 4292268795 ... is invalid"
:: 中止并只产出几百 KB 残片。
:: 修复管线（三步全 copy）：
::   1) MP4 -> TS   ：剥离坏的时长元数据（TS 只存时间戳不存样本时长）
::   2) TS  -> MP4  ：重建干净的样本表（时间线自动归位，广告+正片连续）
::   3) 切掉片头广告（AD_SECS 秒；设 0 = 保留完整文件不切）
:: ============================================================

:: ================== 可调参数 ==================
:: 广告时长（秒）：从该处开始保留正片；设 0 表示不切广告只修复
set "AD_SECS=19"
:: ffmpeg 路径：优先用本目录下的 ffmpeg.exe，找不到再退回 PATH
set "FF=%~dp0ffmpeg.exe"
if not exist "%FF%" set "FF=ffmpeg"
:: ==============================================

if not exist "%FF%" (
    echo 错误：找不到 ffmpeg.exe，请把它和本脚本放在同一目录
    pause
    exit /b 1
)

if not exist "修复完成" md "修复完成"
set /a OKCOUNT=0
set /a FAILCOUNT=0

for %%i in (*.mp4 *.ts *.mkv) do (
    echo.
    echo 正在修复：%%i
    rem ---- 第 1 步：剥离坏时长元数据（TS 容器只存时间戳）----
    "%FF%" -hide_banner -loglevel error -y -i "%%i" -c copy -f mpegts "%TEMP%\vsfix_%%~ni.ts"
    if errorlevel 1 (
        echo   TS 中转失败，尝试直接重封装……
        "%FF%" -hide_banner -loglevel error -y -i "%%i" -c copy -movflags +faststart "修复完成\%%~ni.mp4"
        if errorlevel 1 (
            echo ----------修复失败：%%i（可尝试转码脚本兜底）----------
            del "修复完成\%%~ni.mp4" 2>nul
            set /a FAILCOUNT+=1
        ) else (
            echo   已直接重封装（该文件时间线本身正常）
            set /a OKCOUNT+=1
        )
    ) else (
        rem ---- 第 2 步：重建干净样本表（时间线归位）----
        "%FF%" -hide_banner -loglevel error -y -i "%TEMP%\vsfix_%%~ni.ts" -c copy -movflags +faststart "%TEMP%\vsfix_%%~ni.mp4"
        if errorlevel 1 (
            echo ----------修复失败：%%i（第 2 步重建出错）----------
            set /a FAILCOUNT+=1
        ) else (
            rem ---- 第 3 步：切掉片头广告（AD_SECS=0 时等于原样拷贝）----
            "%FF%" -hide_banner -loglevel error -y -ss %AD_SECS% -i "%TEMP%\vsfix_%%~ni.mp4" -c copy -avoid_negative_ts make_zero -movflags +faststart "修复完成\%%~ni.mp4"
            if errorlevel 1 (
                echo ----------修复失败：%%i（第 3 步切片出错）----------
                del "修复完成\%%~ni.mp4" 2>nul
                set /a FAILCOUNT+=1
            ) else (
                echo   修复完成
                set /a OKCOUNT+=1
            )
        )
        del "%TEMP%\vsfix_%%~ni.ts" "%TEMP%\vsfix_%%~ni.mp4" 2>nul
    )
)

echo.
echo ================================================
echo 全部结束！成功 %OKCOUNT% 个，失败 %FAILCOUNT% 个
echo 输出目录：「修复完成」文件夹（均为手机可播的标准 MP4）
echo 提示：某文件开头仍残留广告 → 调大顶部 AD_SECS 后单独重跑；
echo       想保留完整文件（不切广告）→ AD_SECS 改为 0
echo ================================================
pause
