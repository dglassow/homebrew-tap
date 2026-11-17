class Vitra < Formula
  desc "Coding agent with the IDE wired in"
  homepage "https://github.com/dglassow/Vitra"
  url "https://github.com/dglassow/Vitra/releases/download/v18.5.0/vitra-darwin-arm64.tar.gz"
  version "18.5.0"
  sha256 "41f8f25d6d26086e1ae62a416581b841c0f4207cc01b8c708747a9238e74b402"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "vitra"
    pkgshare.install "LICENSE", "THIRD-PARTY-NOTICES.txt"
  end

  test do
    assert_match "vitra/#{version}", shell_output("#{bin}/vitra --version")
  end
end
