-- LINE macOS App UI Structure Explorer
-- Run this script on your Mac to see what the Accessibility API can read from LINE.
-- Usage: osascript scripts/line-explore.applescript

-- Step 1: Check if LINE is running
tell application "System Events"
	set lineRunning to (name of processes) contains "LINE"
	if not lineRunning then
		return "ERROR: LINE is not running. Please open LINE first."
	end if
end tell

-- Step 2: Get the main window structure
tell application "System Events"
	tell process "LINE"
		set frontmost to true
		delay 0.5

		-- List all windows
		set windowInfo to ""
		set winCount to count of windows
		set windowInfo to "=== LINE Windows: " & winCount & " ===" & linefeed

		repeat with i from 1 to winCount
			set w to window i
			set wName to name of w
			set wRole to role of w
			set wPos to position of w
			set wSize to size of w
			set windowInfo to windowInfo & "Window " & i & ": name=" & wName & " role=" & wRole & " pos=" & (item 1 of wPos as string) & "," & (item 2 of wPos as string) & " size=" & (item 1 of wSize as string) & "," & (item 2 of wSize as string) & linefeed
		end repeat

		-- Step 3: Explore the first window's top-level UI elements
		set windowInfo to windowInfo & linefeed & "=== Window 1 Top-Level Elements ===" & linefeed
		try
			set topElements to UI elements of window 1
			repeat with el in topElements
				set elRole to role of el
				set elDesc to ""
				try
					set elDesc to description of el
				end try
				set elName to ""
				try
					set elName to name of el
				end try
				set elValue to ""
				try
					set elValue to value of el as string
					if length of elValue > 100 then
						set elValue to text 1 thru 100 of elValue & "..."
					end if
				end try
				set windowInfo to windowInfo & "  role=" & elRole & " name=" & elName & " desc=" & elDesc & " value=" & elValue & linefeed

				-- Go one level deeper for groups/scroll areas
				if elRole is "AXGroup" or elRole is "AXScrollArea" or elRole is "AXSplitGroup" then
					try
						set childElements to UI elements of el
						set childCount to count of childElements
						set windowInfo to windowInfo & "    (children: " & childCount & ")" & linefeed
						-- Show first 10 children
						set showCount to childCount
						if showCount > 10 then set showCount to 10
						repeat with j from 1 to showCount
							set ch to item j of childElements
							set chRole to role of ch
							set chName to ""
							try
								set chName to name of ch
							end try
							set chDesc to ""
							try
								set chDesc to description of ch
							end try
							set chVal to ""
							try
								set chVal to value of ch as string
								if length of chVal > 80 then
									set chVal to text 1 thru 80 of chVal & "..."
								end if
							end try
							set windowInfo to windowInfo & "      [" & j & "] role=" & chRole & " name=" & chName & " desc=" & chDesc & " val=" & chVal & linefeed
						end repeat
						if childCount > 10 then
							set windowInfo to windowInfo & "      ... and " & (childCount - 10) & " more" & linefeed
						end if
					end try
				end if
			end repeat
		on error errMsg
			set windowInfo to windowInfo & "  ERROR reading elements: " & errMsg & linefeed
		end try

		return windowInfo
	end tell
end tell
