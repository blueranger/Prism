-- LINE macOS App Deep UI Explorer (Fixed)
-- Usage: osascript scripts/line-explore-deep.applescript

tell application "System Events"
	tell process "LINE"
		set frontmost to true
		delay 0.5

		set output to "=== LINE Deep UI Tree ===" & linefeed

		-- Explore the SplitGroup
		set sg to UI element 1 of window 1
		set sgRole to role of sg
		set output to output & "SplitGroup children:" & linefeed

		set sgChildren to UI elements of sg
		repeat with i from 1 to count of sgChildren
			set el to item i of sgChildren
			set elRole to role of el
			set elName to ""
			try
				set elName to name of el
			end try
			set elDesc to ""
			try
				set elDesc to description of el
			end try
			set output to output & "  [" & i & "] " & elRole & " name=" & elName & " desc=" & elDesc & linefeed

			-- Go deeper into AXList (chat list)
			if elRole is "AXList" then
				set output to output & "    --- AXList children ---" & linefeed
				try
					set listChildren to UI elements of el
					set listCount to count of listChildren
					set output to output & "    count=" & listCount & linefeed

					-- Show first 5 items in the list
					set showMax to listCount
					if showMax > 5 then set showMax to 5
					repeat with j from 1 to showMax
						set li to item j of listChildren
						set liRole to role of li
						set liName to ""
						try
							set liName to name of li
						end try
						set liVal to ""
						try
							set liVal to value of li as string
							if length of liVal > 100 then
								set liVal to text 1 thru 100 of liVal & "..."
							end if
						end try
						set output to output & "      [" & j & "] " & liRole & " name=" & liName & " val=" & liVal & linefeed

						-- Go one more level into each list item
						try
							set itemChildren to UI elements of li
							set icCount to count of itemChildren
							set output to output & "        (sub-elements: " & icCount & ")" & linefeed
							set showIC to icCount
							if showIC > 8 then set showIC to 8
							repeat with k from 1 to showIC
								set ic to item k of itemChildren
								set icRole to role of ic
								set icName to ""
								try
									set icName to name of ic
								end try
								set icVal to ""
								try
									set icVal to value of ic as string
									if length of icVal > 80 then
										set icVal to text 1 thru 80 of icVal & "..."
									end if
								end try
								set icDesc to ""
								try
									set icDesc to description of ic
								end try
								set output to output & "          [" & k & "] " & icRole & " name=" & icName & " desc=" & icDesc & " val=" & icVal & linefeed
							end repeat
						end try
					end repeat
				on error errMsg
					set output to output & "    ERROR: " & errMsg & linefeed
				end try
			end if
		end repeat

		return output
	end tell
end tell
