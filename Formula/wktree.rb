class Wktree < Formula
  desc "Deterministic git worktree manager"
  homepage "https://github.com/codethread/wktree"
  url "https://github.com/codethread/wktree/archive/refs/tags/v0.11.0.tar.gz"
  sha256 "3024a4a2cfaa5d0e8d1674777fdf8a488b1d989e7ed5123a309adeb963cbe400"

  depends_on "bun" => :build
  depends_on "git"

  def install
    system "bun", "install", "--frozen-lockfile", "--ignore-scripts"
    system "bun", "build", "bin/wktree.ts", "--compile", "--outfile", "dist/wktree"
    bin.install "dist/wktree"
  end

  test do
    assert_equal "#{version}\n", shell_output("#{bin}/wktree --version")
    assert_match "Usage: wktree", shell_output("#{bin}/wktree --help 2>&1")
  end
end
