

about-webrtc-document-title = WebRTC Internals

about-webrtc-save-page-dialog-title = save about:webrtc as


about-webrtc-closed-peerconnection-disclosure-show-msg = Show Closed PeerConnections
about-webrtc-closed-peerconnection-disclosure-hide-msg = Hide Closed PeerConnections


about-webrtc-aec-logging-msg-label = AEC Logging
about-webrtc-aec-logging-off-state-label = Start AEC Logging
about-webrtc-aec-logging-on-state-label = Stop AEC Logging
about-webrtc-aec-logging-toggled-on-state-msg = AEC logging active (speak with the caller for a few minutes and then stop the capture)
about-webrtc-aec-logging-unavailable-sandbox = The environment variable MOZ_DISABLE_CONTENT_SANDBOX=1 is required to export AEC logs. Only set this variable if you understand the possible risks.
about-webrtc-aec-logging-toggled-off-state-msg = Captured log files can be found in: { $path }


about-webrtc-auto-refresh-label = Auto Refresh

about-webrtc-force-refresh-button = Refresh


about-webrtc-peerconnection-id-label = PeerConnection ID:

about-webrtc-data-channels-opened-label = Data Channels Opened:

about-webrtc-data-channels-closed-label = Data Channels Closed:


about-webrtc-sdp-heading = SDP
about-webrtc-local-sdp-heading = Local SDP
about-webrtc-local-sdp-heading-offer = Local SDP (Offer)
about-webrtc-local-sdp-heading-answer = Local SDP (Answer)
about-webrtc-remote-sdp-heading = Remote SDP
about-webrtc-remote-sdp-heading-offer = Remote SDP (Offer)
about-webrtc-remote-sdp-heading-answer = Remote SDP (Answer)
about-webrtc-sdp-history-heading = SDP History
about-webrtc-sdp-parsing-errors-heading = SDP Parsing Errors


about-webrtc-rtp-stats-heading = RTP Stats


about-webrtc-ice-state = ICE State
about-webrtc-ice-stats-heading = ICE Stats
about-webrtc-ice-restart-count-label = ICE restarts:
about-webrtc-ice-rollback-count-label = ICE rollbacks:
about-webrtc-ice-pair-bytes-sent = Bytes sent:
about-webrtc-ice-pair-bytes-received = Bytes received:
about-webrtc-ice-component-id = Component ID


about-webrtc-type-local = Local
about-webrtc-type-remote = Remote


about-webrtc-nominated = Nominated

about-webrtc-selected = Selected

about-webrtc-save-page-label = Save Page
about-webrtc-enable-logging-label = Enable WebRTC Log Preset
about-webrtc-peerconnections-section-heading = RTCPeerConnection Statistics
about-webrtc-peerconnections-section-show-msg = Show RTCPeerConnection Statistics
about-webrtc-peerconnections-section-hide-msg = Hide RTCPeerConnection Statistics
about-webrtc-stats-clear = Clear History
about-webrtc-log-heading = Connection Log
about-webrtc-log-clear = Clear Log
about-webrtc-log-section-show-msg = Show Log
    .title = Click to expand this section
about-webrtc-log-section-hide-msg = Hide Log
    .title = Click to collapse this section
about-webrtc-copy-report-button = Copy Report
about-webrtc-copy-report-history-button = Copy Report History


about-webrtc-connection-open = [ { $browser-id } | { $id } ] { $url } { $now }
about-webrtc-connection-closed = [ { $browser-id } | { $id } ] { $url } (closed) { $now }


about-webrtc-short-send-receive-direction = Send / Receive: { $codecs }
about-webrtc-short-send-direction = Send: { $codecs }
about-webrtc-short-receive-direction = Receive: { $codecs }


about-webrtc-local-candidate = Local Candidate
about-webrtc-remote-candidate = Remote Candidate
about-webrtc-raw-candidates-heading = All Raw Candidates
about-webrtc-raw-local-candidate = Raw Local Candidate
about-webrtc-raw-remote-candidate = Raw Remote Candidate
about-webrtc-raw-cand-section-show-msg = Show Raw Candidates
    .title = Click to expand this section
about-webrtc-raw-cand-section-hide-msg = Hide Raw Candidates
    .title = Click to collapse this section
about-webrtc-priority = Priority
about-webrtc-fold-default-show-msg = Show Details
    .title = Click to expand this section
about-webrtc-fold-default-hide-msg = Hide Details
    .title = Click to collapse this section
about-webrtc-dropped-frames-label = Dropped frames:
about-webrtc-discarded-packets-label = Discarded packets:
about-webrtc-decoder-label = Decoder
about-webrtc-encoder-label = Encoder
about-webrtc-show-tab-label = Show tab
about-webrtc-current-framerate-label = Framerate
about-webrtc-width-px = Width (px)
about-webrtc-height-px = Height (px)
about-webrtc-consecutive-frames = Consecutive Frames
about-webrtc-time-elapsed = Time Elapsed (s)
about-webrtc-estimated-framerate = Estimated Framerate
about-webrtc-rotation-degrees = Rotation (degrees)
about-webrtc-first-frame-timestamp = First Frame Reception Timestamp
about-webrtc-last-frame-timestamp = Last Frame Reception Timestamp


about-webrtc-local-receive-ssrc = Local Receiving SSRC
about-webrtc-remote-send-ssrc = Remote Sending SSRC


about-webrtc-pc-configuration-show-msg = Show Configuration
about-webrtc-pc-configuration-hide-msg = Hide Configuration


about-webrtc-configuration-element-provided = Provided

about-webrtc-configuration-element-not-provided = Not Provided

about-webrtc-user-modified-configuration-heading = User Modified WebRTC Configuration


about-webrtc-user-modified-configuration-show-msg = Show User Modified Configuration
about-webrtc-user-modified-configuration-hide-msg = Hide User Modified Configuration


about-webrtc-bandwidth-stats-heading = Estimated Bandwidth

about-webrtc-track-identifier = Track Identifier

about-webrtc-send-bandwidth-bytes-sec = Send Bandwidth (bytes/sec)

about-webrtc-receive-bandwidth-bytes-sec = Receive Bandwidth (bytes/sec)

about-webrtc-max-padding-bytes-sec = Maximum Padding (bytes/sec)

about-webrtc-pacer-delay-ms = Pacer Delay ms

about-webrtc-round-trip-time-ms = RTT ms

about-webrtc-frame-stats-heading = Video Frame Statistics - MediaStreamTrack ID: { $track-identifier }

about-webrtc-save-page-complete-msg = Page saved to: { $path }

about-webrtc-frames =
  { $frames ->
      [one] { $frames } frame
     *[other] { $frames } frames
  }

about-webrtc-channels =
  { $channels ->
      [one] { $channels } channel
     *[other] { $channels } channels
  }

about-webrtc-received-label =
  { $packets ->
      [one] Received { $packets } packet
     *[other] Received { $packets } packets
  }

about-webrtc-lost-label =
  { $packets ->
      [one] Lost { $packets } packet
     *[other] Lost { $packets } packets
  }

about-webrtc-sent-label =
  { $packets ->
      [one] Sent { $packets } packet
     *[other] Sent { $packets } packets
  }

about-webrtc-jitter-label = Jitter { $jitter }

about-webrtc-trickle-caption-msg = Trickled candidates (arriving after answer) are highlighted in blue


about-webrtc-sdp-set-at-timestamp-local = Set Local SDP at timestamp { NUMBER($timestamp, useGrouping: "false") }

about-webrtc-sdp-set-at-timestamp-remote = Set Remote SDP at timestamp { NUMBER($timestamp, useGrouping: "false") }

about-webrtc-sdp-set-timestamp = Timestamp { NUMBER($timestamp, useGrouping: "false") } (+ { $relative-timestamp } ms)


about-webrtc-show-msg-sdp = Show SDP
about-webrtc-hide-msg-sdp = Hide SDP


about-webrtc-media-context-show-msg = Show Media Context
about-webrtc-media-context-hide-msg = Hide Media Context
about-webrtc-media-context-heading = Media Context

