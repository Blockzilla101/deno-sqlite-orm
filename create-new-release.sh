#!/usr/bin/bash
require_clean_work_tree () {
    # Update the index
    git update-index -q --ignore-submodules --refresh
    err=0

    # Disallow unstaged changes in the working tree
    if ! git diff-files --quiet --ignore-submodules --
    then
        echo >&2 "cannot $1: you have unstaged changes."
        git diff-files --name-status -r --ignore-submodules -- >&2
        err=1
    fi

    # Disallow uncommitted changes in the index
    if ! git diff-index --cached --quiet HEAD --ignore-submodules --
    then
        echo >&2 "cannot $1: your index contains uncommitted changes."
        git diff-index --cached --name-status -r --ignore-submodules HEAD -- >&2
        err=1
    fi

    if git diff-index --quiet HEAD --
    then
        echo >&2 "warning: your index contains untracted files."
        # echo >&2 "cannot $1: your index contains untracked files."
        # err=1
    fi

    if [ $err = 1 ]
    then
        echo >&2 "Please commit or stash them."
        exit 1
    fi
}

revert_release () {
    git reset HEAD~1 --hard
    git tag --delete ${release}
    echo "Reverted release"
    exit 0
}

trap 'revert_release' SIGINT

if [[ $# -ne 1 ]]; then
    echo 'create-new-release [new version]'
    exit 1
fi    

require_clean_work_tree "create a release"

release=$1
lastRelease=$(git tag | sort -V | tail -1)

echo "Creating a new release '${release}'"
sed -i "s/${lastRelease}/${release}/g" README.md
echo "Updated README.md"
git add README.md
git commit -m ${release}
git tag ${release}
echo "Created a tag & a commit"

echo "Release is ready for pushing (press any to push)"
read -n 1 -s -r
git push
git push --tags

echo "Done"
