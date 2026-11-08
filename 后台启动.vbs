' PadTrack - start the server without a console window.
' The address is written to "当前地址.txt" in this folder.
Option Explicit

Dim fso, sh, base, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

cmd = """pythonw.exe"" """ & base & "\server.py"""

On Error Resume Next
sh.Run cmd, 0, False

If Err.Number <> 0 Then
  MsgBox "Failed to start PadTrack." & vbCrLf & vbCrLf & _
         "Error: " & Err.Description & vbCrLf & vbCrLf & _
         "Make sure Python is installed and on PATH," & vbCrLf & _
         "or run 启动.bat to see the actual error.", 16, "PadTrack"
End If