class Wktree < Formula
  desc "Deterministic git worktree manager"
  homepage "https://github.com/codethread/wktree"
  url "https://github.com/codethread/wktree.git",
      tag:      "v0.1.1",
      revision: "71de66da4a041b89036f090c94fbc354a7ce2584"

  depends_on "bun"
  depends_on "git"

  def install
    system "bun", "install", "--production", "--frozen-lockfile", "--ignore-scripts"

    libexec.install Dir["*"]

    (bin/"wktree").write <<~EOS
      #!/usr/bin/env bash
      exec "#{formula_opt_bin("bun")}/bun" run "#{libexec}/bin/wktree.ts" "$@"
    EOS
  end

  test do
    assert_match "Usage: wktree", shell_output("#{bin}/wktree --help 2>&1")
  end
end
