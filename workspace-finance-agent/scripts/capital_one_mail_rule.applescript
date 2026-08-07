-- Mail.app rule handler for immediate Capital One transaction ingestion.
--
-- Install the compiled script in Mail's application-scripts directory and
-- select it as the "Run AppleScript" action on a rule whose sender contains
-- capitalone.com. The existing parser remains the source of truth for event
-- filtering, exact-email deduplication, database writes, and dashboard push.

property parserPath : "/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/parse_transaction.py"

using terms from application "Mail"
	on perform mail action with messages theMessages for rule theRule
		repeat with theMessage in theMessages
			set tempPath to missing value
			try
				set rawSource to source of theMessage
				set tempPath to do shell script "/usr/bin/mktemp /tmp/openclaw-capital-one-mail.XXXXXX"

				set tempFile to open for access (POSIX file tempPath) with write permission
				try
					set eof tempFile to 0
					write rawSource to tempFile as «class utf8»
				on error errorMessage number errorNumber
					close access tempFile
					error errorMessage number errorNumber
				end try
				close access tempFile

				do shell script "/usr/bin/python3 " & quoted form of parserPath & " < " & quoted form of tempPath
			on error errorMessage number errorNumber
				do shell script "/usr/bin/logger -t openclaw-finance-mail " & quoted form of ("Mail rule failed (" & errorNumber & "): " & errorMessage)
			end try

			if tempPath is not missing value then
				try
					do shell script "/bin/rm -f -- " & quoted form of tempPath
				end try
			end if
		end repeat
	end perform mail action with messages
end using terms from
