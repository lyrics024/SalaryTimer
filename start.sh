#!/bin/bash
# ---------------------------------------------------------------
# SalaryTimer · 启动器
#   双击运行，或在本目录执行  ./start.sh
#   参数：-f / --foreground  前台运行（终端里能看到日志，Ctrl+C 退出）
#         --rebuild          强制重新编译
#         --reset            备份当前数据后重新开始
#         -h / --help        帮助
# ---------------------------------------------------------------
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/app/main.swift"
PLIST_SRC="$DIR/app/Info.plist"
UI="$DIR/app/ui"
APP_BUNDLE="$DIR/.build/SalaryBoard.app"
BIN="$APP_BUNDLE/Contents/MacOS/SalaryBoard"
LOG="$DIR/.build/launch.log"
STATE="$HOME/Library/Application Support/SalaryTimer/state.json"

FOREGROUND=0
REBUILD=0
RESET=0

usage() {
  echo "SalaryTimer"
  echo "  ./start.sh              启动悬浮窗口（后台常驻）"
  echo "  ./start.sh -f           前台启动，终端里看日志"
  echo "  ./start.sh --rebuild    强制重新编译"
  echo "  ./start.sh --reset      备份现有数据并重新开始"
  echo ""
  echo "  数据目录：$HOME/Library/Application Support/SalaryTimer"
  echo "  导出目录：$DIR/exports"
}

pause_if_needed() {
  if [ -t 0 ]; then
    read -r -p "按回车键关闭窗口…" _
  fi
}

for arg in "$@"; do
  case "$arg" in
    -f|--foreground) FOREGROUND=1 ;;
    --rebuild) REBUILD=1 ;;
    --reset) RESET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$arg"; echo ""; usage; exit 1 ;;
  esac
done

# 界面文件是否齐全
if [ ! -f "$SRC" ] || [ ! -f "$UI/index.html" ]; then
  echo "文件不完整：缺少 app/main.swift 或 app/ui/index.html"
  echo "请确认整个 SalaryTimer 文件夹被一起拷贝。"
  pause_if_needed
  exit 1
fi

# 已经在运行就不重复开
if pgrep -f "\.build/SalaryBoard" >/dev/null 2>&1; then
  echo "SalaryTimer已经在运行了（窗口默认置顶，可在窗口里点 × 退出）。"
  exit 0
fi

# 重置数据
if [ "$RESET" -eq 1 ] && [ -f "$STATE" ]; then
  BACKUP="${STATE%.json}-backup-$(date +%Y%m%d-%H%M%S).json"
  mv "$STATE" "$BACKUP" && echo "已备份原数据到：$BACKUP"
fi

# 编译工具
if ! command -v swiftc >/dev/null 2>&1; then
  echo "缺少编译工具 swiftc。"
  echo ""
  echo "请先安装 Xcode 命令行工具（免费，约几分钟）："
  echo "    xcode-select --install"
  echo "装好后重新运行 ./start.sh 即可。"
  pause_if_needed
  exit 1
fi

mkdir -p "$APP_BUNDLE/Contents/MacOS"

need_build=0
[ -x "$BIN" ] || need_build=1
[ "$REBUILD" -eq 1 ] && need_build=1
[ -f "$APP_BUNDLE/Contents/Info.plist" ] || need_build=1
if [ -x "$BIN" ] && [ "$SRC" -nt "$BIN" ]; then need_build=1; fi

if [ "$need_build" -eq 1 ]; then
  echo "首次启动，正在准备运行环境（约 10 秒，只会做一次）…"
  if ! swiftc -O -o "$BIN" "$SRC" 2>"$LOG"; then
    echo ""
    echo "编译失败，日志如下："
    tail -n 25 "$LOG"
    pause_if_needed
    exit 1
  fi
  cp "$PLIST_SRC" "$APP_BUNDLE/Contents/Info.plist"
  # 让 LaunchServices 重新识别这个 .app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" >/dev/null 2>&1
  touch "$APP_BUNDLE"
  echo "运行环境已就绪。"
fi

if [ "$FOREGROUND" -eq 1 ]; then
  echo "前台启动，日志跟随系统日志；关闭窗口或 Ctrl+C 结束。"
  exec open -n -W "$APP_BUNDLE" --args "$UI"
fi

open -n "$APP_BUNDLE" --args "$UI" >/dev/null 2>&1
sleep 1.8

if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "SalaryTimer已启动 · 窗口默认置顶，可拖动缩放"
  echo "退出：点窗口右上角 ×，或设置页里的「退出看板」"
else
  echo "启动失败。尝试直接前台运行看报错：./start.sh -f"
  pause_if_needed
  exit 1
fi
