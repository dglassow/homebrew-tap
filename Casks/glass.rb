cask "glass" do
  version "0.3.3"
  sha256 "3f31a6fa3b729548fa5f5220f351a2c61b0a20a1e9c7072329c6d3459fc0eb90"

  url "https://github.com/dglassow/Glass/releases/download/v#{version}/Glass.dmg"
  name "Glass"
  desc "Secure local and remote AI agent workspace"
  homepage "https://github.com/dglassow/Glass"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Glass.app"
  # Deliberate cleanup is separate from brew uninstall so replacing the app
  # never stops the persistent backend or a Glass-hosted terminal session.
  generated_script "glass-homebrew-lifecycle", content: <<~'RUBY'
    #!/usr/bin/ruby
    require "open3"

    action, appdir, brew = ARGV
    abort "Use the glass-uninstall command" unless action == "uninstall" && appdir && brew
    app = File.join(appdir, "Glass.app")
    def plist_value(path, key)
      output, _error, status = Open3.capture3("/usr/libexec/PlistBuddy", "-c", "Print #{key}", path)
      status.success? ? output.strip : nil
    end

    home = ENV.fetch("HOME")
    agents = File.join(home, "Library", "LaunchAgents")
    service = File.join(home, ".glass", "service")
    labels = {
      "com.glassow.glass.backend" => [
        File.join(service, "node"), File.join(service, "glassd.mjs"),
        "--service-dir", service, "--config", File.join(service, "config.json"),
        "--control", File.join(service, "control.sock"), "--controller-id",
      ],
      "com.glassow.glass.computer" => ["/usr/bin/open", "-gj", app],
    }

    labels.each do |label, arguments|
      plist = File.join(agents, "#{label}.plist")
      domain = "gui/#{Process.uid}/#{label}"
      output, _error, loaded = Open3.capture3("/bin/launchctl", "print", domain)
      registered = output[/^\s*path = (.+)$/, 1]&.strip
      if loaded.success? && registered != plist
        abort "Refusing to stop #{label}: loaded service is not registered from #{plist}"
      end
      unless File.file?(plist) && !File.symlink?(plist)
        abort "Refusing to remove #{label}: owned launch agent is missing" if loaded.success?
        next
      end

      recorded = [":Label", *arguments.each_index.map { |index| ":ProgramArguments:#{index}" }]
        .map { |key| plist_value(plist, key) }
      last_index = arguments.length
      last = plist_value(plist, ":ProgramArguments:#{last_index}")
      if label == "com.glassow.glass.backend"
        valid_tail = last&.match?(/\A[0-9a-f]{64}\z/)
        last_index += 1
      else
        valid_tail = last.nil?
      end
      owned = recorded == [label, *arguments] && valid_tail &&
        plist_value(plist, ":ProgramArguments:#{last_index}").nil?
      unless owned
        abort "Refusing to stop #{label}: launch agent contents differ" if loaded.success?
        next
      end

      if loaded.success?
        abort "Could not stop #{label}" unless system("/bin/launchctl", "bootout", domain)
      end
      File.unlink(plist)
    end

    {
      "glass" => File.join(service, "glass"),
      "glassctl" => File.join(app, "Contents", "MacOS", "glass-desktop"),
    }.each do |name, target|
      link = File.join(home, ".local", "bin", name)
      File.unlink(link) if File.symlink?(link) && File.readlink(link) == target
    end

    abort "Homebrew could not uninstall Glass" unless system(brew, "uninstall", "--cask", "dglassow/tap/glass")
  RUBY
  command_wrapper "glass-uninstall",
                  executable: "#{staged_path}/glass-homebrew-lifecycle",
                  args:       ["uninstall", appdir.to_s, HOMEBREW_BREW_FILE.to_s]

  # Homebrew compares receipt versions, not a bundle updated by Glass itself.
  # A forced or greedy upgrade must not replace a newer signed app with an
  # older tap release. The old bundle is in *.upgrading during an upgrade.
  preflight_steps do
    run "/usr/bin/ruby", args: [
      "-e", <<~'RUBY', "{{appdir}}", "{{caskroom_path}}", "{{version}}"
        require "open3"
        require "rubygems/version"

        appdir, caskroom, candidate = ARGV
        abort "Invalid Glass tap version" unless candidate.match?(/\A\d+\.\d+\.\d+\z/)
        os_version, _error, os_status = Open3.capture3("/usr/bin/sw_vers", "-productVersion")
        abort "Glass requires macOS 13.5 or newer" unless os_status.success? &&
          Gem::Version.new(os_version.strip) >= Gem::Version.new("13.5")
        plists = [File.join(appdir, "Glass.app", "Contents", "Info.plist")]
        plists.concat(Dir.glob(File.join(caskroom, "*.upgrading", "Glass.app", "Contents", "Info.plist")))
        plists.each do |plist|
          next unless File.file?(plist)

          installed, _error, status = Open3.capture3(
            "/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", plist
          )
          abort "Cannot verify installed Glass version" unless status.success? &&
            installed.strip.match?(/\A\d+\.\d+\.\d+\z/)
          if Gem::Version.new(installed.strip) > Gem::Version.new(candidate)
            abort "Installed Glass #{installed.strip} is newer than Homebrew #{candidate}; use Glass's signed updater"
          end
        end
      RUBY
    ]
  end
end
