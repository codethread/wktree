class Wktree < Formula
  desc "Deterministic git worktree manager"
  homepage "https://github.com/codethread/wktree"
  url "https://github.com/codethread/wktree.git",
      tag:      "v0.10.0",
      revision: "f89aaf960549158cbb75ba89e036ed5097085639"

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
