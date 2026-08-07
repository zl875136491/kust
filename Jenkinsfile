pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        timeout(time: 90, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '30'))
        timestamps()
    }

    parameters {
        booleanParam(name: 'DEPLOY_TEST', defaultValue: true, description: 'Deploy the immutable image to /kust_test')
        booleanParam(name: 'DEPLOY_PRODUCTION', defaultValue: true, description: 'Deploy the immutable image to /kust after test succeeds')
    }

    environment {
        HARBOR_REGISTRY = '10.17.158.118'
        BACKEND_IMAGE_REPOSITORY = '10.17.158.118/kust/kust_backend'
        FRONTEND_IMAGE_REPOSITORY = '10.17.158.118/kust/kust_frontend'
        SOURCE_URL = 'https://github.com/zl875136491/kust'
        KUBE_API = 'https://10.17.158.69:6443'
        KUBE_NAMESPACE = 'custom-apps'
        PUBLIC_HOST = 'k8s.1oa.com.cn'
        PUBLIC_GATEWAY_IP = '10.17.158.71'
        USER_INFO_URL = 'http://tl.cooacloud.com/springboard_v3/get_user_from_itcode'
        USER_INFO_HOST = 'tl.cooacloud.com'
        USER_INFO_HOST_IP = '10.32.129.1'
        BUILDKIT_NO_CLIENT_TOKEN = 'true'
        HTTP_PROXY = 'http://10.32.129.253:10811'
        HTTPS_PROXY = 'http://10.32.129.253:10811'
        NO_PROXY = 'localhost,127.0.0.1,::1,10.17.158.69,10.17.158.71,10.17.158.118,10.17.158.156,k8s.1oa.com.cn'
    }

    stages {
        stage('Checkout') {
            steps {
                script {
                    def scmVars = [:]
                    int attempt = 0
                    retry(3) {
                        attempt++
                        if (attempt > 1) {
                            sleep time: attempt == 2 ? 5 : 10, unit: 'SECONDS'
                        }
                        deleteDir()
                        scmVars = checkout(scm) ?: [:]
                    }

                    def revision = (scmVars.GIT_COMMIT ?: sh(
                        script: 'git rev-parse HEAD',
                        returnStdout: true
                    ).trim()).toLowerCase()
                    if (!(revision ==~ /[0-9a-f]{40}/)) {
                        error("Unable to determine a full Git commit SHA: '${revision}'.")
                    }

                    def sourceBranch = env.BRANCH_NAME ?: env.GIT_BRANCH?.replaceFirst(/^origin\//, '')
                    if (!sourceBranch) {
                        sourceBranch = sh(script: 'git branch --show-current', returnStdout: true).trim()
                    }

                    env.GIT_COMMIT_SHA = revision
                    env.SOURCE_BRANCH = sourceBranch
                    env.IS_MAIN = sourceBranch == 'main' ? 'true' : 'false'
                    env.IMAGE_TAG = "sha-${revision.take(12)}"
                    env.BACKEND_IMAGE_REF = "${env.BACKEND_IMAGE_REPOSITORY}:${env.IMAGE_TAG}"
                    env.FRONTEND_IMAGE_REF = "${env.FRONTEND_IMAGE_REPOSITORY}:${env.IMAGE_TAG}"
                    env.BACKEND_CI_IMAGE = "kust-backend-ci:${env.BUILD_NUMBER}-${revision.take(12)}"
                    env.FRONTEND_CI_IMAGE = "kust-frontend-ci:${env.BUILD_NUMBER}-${revision.take(12)}"
                    currentBuild.displayName = env.IMAGE_TAG
                }
            }
        }

        stage('Backend CI') {
            steps {
                sh(label: 'Rust fmt, clippy and tests', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
docker build \
  --target test \
  --platform linux/amd64 \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --tag "$BACKEND_CI_IMAGE" \
  ./backend
''')
            }
        }

        stage('Frontend CI') {
            steps {
                sh(label: 'Frontend lint and build', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
docker build \
  --target build \
  --platform linux/amd64 \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --tag "$FRONTEND_CI_IMAGE" \
  ./frontend
''')
            }
        }

        stage('Build Images') {
            when {
                expression { env.IS_MAIN == 'true' }
            }
            steps {
                sh(label: 'Build immutable runtime images', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
docker build \
  --provenance=false \
  --platform linux/amd64 \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --build-arg "VCS_REF=$GIT_COMMIT_SHA" \
  --build-arg "IMAGE_VERSION=$IMAGE_TAG" \
  --build-arg "SOURCE_URL=$SOURCE_URL" \
  --tag "$BACKEND_IMAGE_REF" \
  ./backend

docker build \
  --provenance=false \
  --platform linux/amd64 \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --build-arg "VCS_REF=$GIT_COMMIT_SHA" \
  --build-arg "IMAGE_VERSION=$IMAGE_TAG" \
  --build-arg "SOURCE_URL=$SOURCE_URL" \
  --tag "$FRONTEND_IMAGE_REF" \
  ./frontend

test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$BACKEND_IMAGE_REF")" = "$GIT_COMMIT_SHA"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.component" }}' "$BACKEND_IMAGE_REF")" = 'backend'
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$FRONTEND_IMAGE_REF")" = "$GIT_COMMIT_SHA"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.component" }}' "$FRONTEND_IMAGE_REF")" = 'frontend'
''')
            }
        }

        stage('Push Images') {
            when {
                expression { env.IS_MAIN == 'true' }
            }
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'infra_harbor_auth',
                    usernameVariable: 'HARBOR_USERNAME',
                    passwordVariable: 'HARBOR_PASSWORD'
                )]) {
                    sh(label: 'Push images to Harbor', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
set +x

DOCKER_CONFIG="$(mktemp -d "${WORKSPACE_TMP:-/tmp}/kust-docker-config.XXXXXX")"
export DOCKER_CONFIG
trap 'docker logout "$HARBOR_REGISTRY" >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT HUP INT TERM

printf '%s' "$HARBOR_PASSWORD" | docker login "$HARBOR_REGISTRY" --username "$HARBOR_USERNAME" --password-stdin >/dev/null
unset HARBOR_USERNAME HARBOR_PASSWORD

docker push "$BACKEND_IMAGE_REF" 2>&1 | tee backend-push.log
docker push "$FRONTEND_IMAGE_REF" 2>&1 | tee frontend-push.log

awk '/digest: sha256:/{for (i = 1; i <= NF; i++) if ($i ~ /^sha256:/) {print $i; exit}}' backend-push.log > backend-image.digest
awk '/digest: sha256:/{for (i = 1; i <= NF; i++) if ($i ~ /^sha256:/) {print $i; exit}}' frontend-push.log > frontend-image.digest
grep -Eq '^sha256:[0-9a-f]{64}$' backend-image.digest
grep -Eq '^sha256:[0-9a-f]{64}$' frontend-image.digest
''')
                }

                script {
                    env.BACKEND_IMAGE_DIGEST = readFile('backend-image.digest').trim()
                    env.FRONTEND_IMAGE_DIGEST = readFile('frontend-image.digest').trim()
                    env.BACKEND_DIGEST_REF = "${env.BACKEND_IMAGE_REPOSITORY}@${env.BACKEND_IMAGE_DIGEST}"
                    env.FRONTEND_DIGEST_REF = "${env.FRONTEND_IMAGE_REPOSITORY}@${env.FRONTEND_IMAGE_DIGEST}"

                    writeFile(file: 'images.properties', text: [
                        "GIT_COMMIT=${env.GIT_COMMIT_SHA}",
                        "IMAGE_TAG=${env.IMAGE_TAG}",
                        "BACKEND_IMAGE=${env.BACKEND_IMAGE_REF}",
                        "BACKEND_DIGEST_REF=${env.BACKEND_DIGEST_REF}",
                        "FRONTEND_IMAGE=${env.FRONTEND_IMAGE_REF}",
                        "FRONTEND_DIGEST_REF=${env.FRONTEND_DIGEST_REF}"
                    ].join('\n') + '\n')
                    archiveArtifacts artifacts: 'images.properties', fingerprint: true, onlyIfSuccessful: true
                }
            }
        }

        stage('Deploy Test') {
            when {
                allOf {
                    expression { env.IS_MAIN == 'true' }
                    expression { params.DEPLOY_TEST }
                }
            }
            steps {
                withCredentials([string(credentialsId: 'tianjin_k8s_admin_token', variable: 'KUBE_TOKEN')]) {
                    sh(label: 'Deploy /kust_test', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
./deploy/k8s/apply.sh test "$BACKEND_DIGEST_REF" "$FRONTEND_DIGEST_REF"
''')
                }
            }
        }

        stage('Deploy Production') {
            when {
                allOf {
                    expression { env.IS_MAIN == 'true' }
                    expression { params.DEPLOY_PRODUCTION }
                }
            }
            steps {
                withCredentials([string(credentialsId: 'tianjin_k8s_admin_token', variable: 'KUBE_TOKEN')]) {
                    sh(label: 'Deploy /kust', script: '''#!/usr/bin/env bash
set -Eeuo pipefail
./deploy/k8s/apply.sh production "$BACKEND_DIGEST_REF" "$FRONTEND_DIGEST_REF"
''')
                }
            }
        }
    }

    post {
        always {
            sh '''#!/usr/bin/env bash
set +e
for image in "$BACKEND_CI_IMAGE" "$FRONTEND_CI_IMAGE" "$BACKEND_IMAGE_REF" "$FRONTEND_IMAGE_REF"; do
  if [ -n "$image" ]; then
    docker image rm "$image" >/dev/null 2>&1 || true
  fi
done
'''
            deleteDir()
        }
        success {
            echo "Kust pipeline completed for ${env.GIT_COMMIT_SHA ?: 'the checked-out revision'}."
        }
        failure {
            echo 'Kust CI/CD pipeline failed.'
        }
    }
}
