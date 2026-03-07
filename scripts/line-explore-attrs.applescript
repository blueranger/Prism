-- LINE: Dump all attributes of chat list rows
-- Usage: osascript scripts/line-explore-attrs.applescript

tell application "System Events"
	tell process "LINE"
		set frontmost to true
		delay 0.5

		set output to ""

		-- Get the AXList (chat list)
		set chatList to UI element 1 of UI element 1 of window 1
		set output to output & "Chat list role: " & role of chatList & linefeed

		-- Dump ALL attributes of Row 1
		set output to output & linefeed & "=== Row 1: all attributes ===" & linefeed
		try
			set firstRow to row 1 of chatList
			set allAttrs to attributes of firstRow
			repeat with a in allAttrs
				set aName to name of a
				set aVal to ""
				try
					set aVal to value of a as string
					if length of aVal > 150 then
						set aVal to text 1 thru 150 of aVal & "..."
					end if
				end try
				set output to output & "  " & aName & " = " & aVal & linefeed
			end repeat
		on error errMsg
			set output to output & "  ERROR: " & errMsg & linefeed
		end try

		-- Dump ALL attributes of StaticText inside Row 1
		set output to output & linefeed & "=== Row 1 > StaticText: all attributes ===" & linefeed
		try
			set stEl to UI element 1 of row 1 of chatList
			set allAttrs to attributes of stEl
			repeat with a in allAttrs
				set aName to name of a
				set aVal to ""
				try
					set aVal to value of a as string
					if length of aVal > 150 then
						set aVal to text 1 thru 150 of aVal & "..."
					end if
				end try
				set output to output & "  " & aName & " = " & aVal & linefeed
			end repeat
		on error errMsg
			set output to output & "  ERROR: " & errMsg & linefeed
		end try

		-- Check rows 2-4: dump attributes of each row and its children
		set output to output & linefeed & "=== Rows 2-4: children info ===" & linefeed
		repeat with i from 2 to 4
			try
				set r to row i of chatList
				set rowChildren to UI elements of r
				set cc to count of rowChildren
				set output to output & "Row " & i & ": " & cc & " children" & linefeed
				repeat with j from 1 to cc
					set ch to item j of rowChildren
					set chRole to role of ch
					set chVal to ""
					try
						set chVal to value of ch as string
						if length of chVal > 100 then
							set chVal to text 1 thru 100 of chVal & "..."
						end if
					end try
					set chName to ""
					try
						set chName to name of ch
					end try
					set chDesc to ""
					try
						set chDesc to description of ch
					end try
					-- count sub-children
					set subCount to 0
					try
						set subCount to count of UI elements of ch
					end try
					set output to output & "  [" & j & "] " & chRole & " name=" & chName & " desc=" & chDesc & " val=" & chVal & " subChildren=" & subCount & linefeed
				end repeat
			on error errMsg
				set output to output & "Row " & i & " ERROR: " & errMsg & linefeed
			end try
		end repeat

		-- Check if right panel exists (selected chat messages)
		set output to output & linefeed & "=== SplitGroup children ===" & linefeed
		try
			set sg to UI element 1 of window 1
			set sgChildren to UI elements of sg
			set sgCount to count of sgChildren
			set output to output & "Total children: " & sgCount & linefeed
			repeat with i from 1 to sgCount
				set ch to item i of sgChildren
				set chRole to role of ch
				set chCC to 0
				try
					set chCC to count of UI elements of ch
				end try
				set output to output & "  [" & i & "] " & chRole & " children=" & chCC & linefeed

				-- For anything beyond the list/textfield/growarea, explore deeper
				if chRole is not "AXList" and chRole is not "AXTextField" and chRole is not "AXGrowArea" then
					try
						set innerKids to UI elements of ch
						set showMax to count of innerKids
						if showMax > 10 then set showMax to 10
						repeat with j from 1 to showMax
							set ik to item j of innerKids
							set ikRole to role of ik
							set ikVal to ""
							try
								set ikVal to value of ik as string
								if length of ikVal > 80 then
									set ikVal to text 1 thru 80 of ikVal & "..."
								end if
							end try
							set ikName to ""
							try
								set ikName to name of ik
							end try
							set ikCC to 0
							try
								set ikCC to count of UI elements of ik
							end try
							set output to output & "    [" & j & "] " & ikRole & " name=" & ikName & " val=" & ikVal & " children=" & ikCC & linefeed
						end repeat
					end try
				end if
			end repeat
		end try

		return output
	end tell
end tell
