
contentanalysis-alert-title = Content Analysis

contentanalysis-slow-agent-notification = The Content Analysis tool is taking a long time to respond for resource “{ $content }”
contentanalysis-slow-agent-dialog-header = Scan in progress

contentanalysis-slow-agent-dialog-body-file = { $agent } is reviewing “{ $filename }” against your organization’s data policies. This may take a moment.
contentanalysis-slow-agent-dialog-body-file-and-more =
    { $count ->
        [one] { $agent } is reviewing “{ $filename }” and { $count } additional item against your organization’s data policies. This may take a moment.
       *[other] { $agent } is reviewing “{ $filename }” and { $count } additional items against your organization’s data policies. This may take a moment.
    }
contentanalysis-slow-agent-dialog-body-clipboard = { $agent } is reviewing what you pasted against your organization’s data policies. This may take a moment.
contentanalysis-slow-agent-dialog-body-clipboard-copy = { $agent } is reviewing what you copied against your organization’s data policies. This may take a moment.
contentanalysis-slow-agent-dialog-body-dropped-text = { $agent } is reviewing the text you dropped against your organization’s data policies. This may take a moment.
contentanalysis-slow-agent-dialog-body-print = { $agent } is reviewing what you printed against your organization’s data policies. This may take a moment.
contentanalysis-clipboard-copy-blocked-replacement = Copying this content is restricted by your organization.

contentanalysis-operationtype-clipboard = clipboard
contentanalysis-operationtype-clipboard-copy = copied content
contentanalysis-operationtype-dropped-text = dropped text
contentanalysis-operationtype-print = print
contentanalysis-upload-description = upload of “{ $filename }”
contentanalysis-download-description = download of “{ $filename }”

contentanalysis-warndialogtitle = This content may be unsafe

contentanalysis-warndialogtext = Your organization uses data-loss prevention software that has flagged this content as unsafe: { $content }. Use it anyway?
contentanalysis-warndialog-response-allow = Use content
contentanalysis-warndialog-response-deny = Cancel

contentanalysis-notification-title = Content Analysis
contentanalysis-genericresponse-message = Content Analysis responded with { $response } for resource: { $content }
contentanalysis-block-message = Your organization uses data-loss prevention software that has blocked this content: { $content }.
contentanalysis-unspecified-error-message-content = An error occurred in communicating with { $agent }. { $content }
contentanalysis-no-agent-connected-message-content = Unable to connect to { $agent }. { $content }
contentanalysis-invalid-agent-signature-message-content = Failed signature verification for { $agent }. { $content }
contentanalysis-error-message-upload-file = Upload of “{ $filename }” denied.
contentanalysis-error-message-dropped-text = Drag and drop denied.
contentanalysis-error-message-clipboard = Paste denied.
contentanalysis-error-message-clipboard-copy = Copy denied.
contentanalysis-error-message-print = Print denied.

contentanalysis-timeout-block-error-message-content = The connection to { $agent } timed out. { $contentName } has been blocked.

contentanalysis-block-dialog-title-upload-file = You’re not permitted to upload this file
contentanalysis-block-dialog-body-upload-file = Under your organization’s data protection policies, you’re not permitted to upload the file “{ $filename }”. Contact your administrator for more info.
contentanalysis-block-dialog-title-download-file = You’re not permitted to download this file
contentanalysis-block-dialog-body-download-file = Under your organization’s data protection policies, you’re not permitted to download the file “{ $filename }”. Contact your administrator for more info.
contentanalysis-block-dialog-title-clipboard = You’re not permitted to paste this content
contentanalysis-block-dialog-body-clipboard = Under your organization’s data protection policies, you’re not permitted to paste this content. Contact your administrator for more info.
contentanalysis-block-dialog-title-clipboard-copy = You’re not permitted to copy this content
contentanalysis-block-dialog-body-clipboard-copy = Under your organization’s data protection policies, you’re not permitted to copy this content. Contact your administrator for more info.
contentanalysis-block-dialog-title-dropped-text = You’re not permitted to drop this content
contentanalysis-block-dialog-body-dropped-text = Under your organization’s data protection policies, you’re not permitted to drag and drop this content. Contact your administrator for more info.
contentanalysis-block-dialog-title-print = You’re not permitted to print this document
contentanalysis-block-dialog-body-print = Under your organization’s data protection policies, you’re not permitted to print this document. Contact your administrator for more info.

contentanalysis-inprogress-quit-title = Quit { -brand-shorter-name }?
contentanalysis-inprogress-quit-message = Several actions are in progress. If you quit { -brand-shorter-name }, these actions will not be completed.
contentanalysis-inprogress-quit-yesbutton = Yes, quit
