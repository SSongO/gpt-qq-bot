Option Explicit
Dim shell, fs, folder, node, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
folder = fs.GetParentFolderName(WScript.ScriptFullName)
node = folder & "\runtime\node.exe"
If Not fs.FileExists(node) Then
  node = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
End If
If Not fs.FileExists(node) Then
  MsgBox "Node.js is missing. Please use start.cmd or reinstall GPT QQ Bot.", 16, "GPT QQ Bot"
  WScript.Quit 1
End If
shell.CurrentDirectory = folder
result = shell.Run(Chr(34) & node & Chr(34) & " " & Chr(34) & folder & "\src\launcher.js" & Chr(34), 0, True)
If result <> 0 Then
  MsgBox "GPT QQ Bot could not start. See state\launcher-error.log in: " & folder, 16, "GPT QQ Bot"
End If
WScript.Quit result
