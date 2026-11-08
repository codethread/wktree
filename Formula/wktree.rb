class Wktree < Formula
  desc "Deterministic git worktree manager"
  homepage "https://github.com/codethread/wktree"
  url "https://github.com/codethread/wktree/archive/refs/tags/v0.10.0.tar.gz"
  sha256 "591794139711db1be7e8267bab0ecc26d0e72e9234573bb02f3b64c43a779b8c"

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
