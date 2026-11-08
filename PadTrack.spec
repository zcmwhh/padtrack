# -*- mode: python ; coding: utf-8 -*-

# comtypes 的 numpy 支持是惰性导入的可选功能，本项目用不到，
# 但 PyInstaller 会顺着那条 import 把 20MB 的 numpy 打进来，所以显式排除。
# tkinter 同理：界面全在网页里，不需要 GUI 工具包。

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=[('web', 'web')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['numpy', 'tkinter', 'unittest', 'pydoc_data'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='PadTrack',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='PadTrack',
)
