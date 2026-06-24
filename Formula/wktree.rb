class Wktree < Formula
  desc "Deterministic git worktree manager"
  homepage "https://github.com/codethread/wktree"
  head "https://github.com/codethread/wktree.git", branch: "main"

  depends_on "bun"
  depends_on "git"

  def install
    system "bun", "install", "--production", "--frozen-lockfile", "--ignore-scripts"

    libexec.install Dir["*"]

    (bin/"wktree").write <<~EOS
      #!/usr/bin/env bash
      exec "#{Formula["bun"].opt_bin}/bun" run "#{libexec}/bin/wktree.ts" "$@"
    EOS
  end

  test do
    assert_match "Usage: wktree", shell_output("#{bin}/wktree --help 2>&1")
  end
end
