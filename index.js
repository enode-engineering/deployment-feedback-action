const core = require("@actions/core");
const {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} = require("@aws-sdk/client-ecs");
const semver = require("semver");
const github = require("@actions/github");

const REGION = "eu-north-1";

const ENV_VERSION_COMPARATOR = {
  dev: ">=", // Deploy all newer versions
  preview: "^", // Deploy only minor and patch versions
  production: "~", // Deploy only patches
};

async function getCurrentImage(env, key, secret, repoName, cluster, service) {
  const client = new ECSClient({
    region: REGION,
    credentials: {
      accessKeyId: key,
      secretAccessKey: secret,
    },
  });

  const describeServiceCmd = new DescribeServicesCommand({
    cluster,
    services: [service],
  });

  const results = await client.send(describeServiceCmd);

  const taskDefinition = results.services[0].taskDefinition;

  const describeTaskCmd = new DescribeTaskDefinitionCommand({
    taskDefinition,
  });
  const taskDefRes = await client.send(describeTaskCmd);

  const td = taskDefRes.taskDefinition;
  const cds = td.containerDefinitions;
  const cdx = cds.find((c) => new RegExp(repoName).test(c.image));
  const currentImage = `${cdx.image}`;

  return {
    image: currentImage,
    tag: currentImage.split(":")[1],
  };
}

async function deploymentFeedback(opts) {
  const {
    releaseVersion,
    repoName,
    clusterName,
    serviceName,

    devEcsKey,
    devEcsSecret,
    previewEcsKey,
    previewEcsSecret,
    productionEcsKey,
    productionEcsSecret,
  } = opts;

  const ECS = {
    dev: {
      key: devEcsKey,
      secret: devEcsSecret,
    },
    preview: {
      key: previewEcsKey,
      secret: previewEcsSecret,
    },
    production: {
      key: productionEcsKey,
      secret: productionEcsSecret,
    },
  };

  const envs = Object.keys(ENV_VERSION_COMPARATOR).filter((env) => {
    const hasCredentials = !!ECS[env];
    return hasCredentials;
  });

  const images = Promise.all(
    envs.map(async (env) => {
      let image;
      let willBeReplaced = false;
      try {
        image = await getCurrentImage(
          env,
          ECS[env].key,
          ECS[env].secret,
          repoName,
          `${env}-${clusterName}`,
          `${env}-${serviceName}`,
        );

        const currentImageTag = image.tag;
        const versionComparator = ENV_VERSION_COMPARATOR[env];
        const isCurrentImageSemver = semver.parse(currentImageTag);
        const semverRange = `${versionComparator}${currentImageTag}`;

        // Treat prereleases as builds. The + sign is not allowed as
        // an ECR tag, so we convert it here.
        const tagAsBuild = releaseVersion.replace("-", "+");

        if (isCurrentImageSemver && semver.satisfies(tagAsBuild, semverRange)) {
          willBeReplaced = true;
        } else if (/^latest/.test(currentImageTag)) {
          willBeReplaced = true;
        }

        return {
          env,
          currentImageTag,
          releaseVersion,
          willBeReplaced,
        };
      } catch (err) {
        console.log("Error fetching current image:", err);
      }
    }),
  );

  return images;
}

async function createComment(token, owner, repo, issueNumber, body) {
  const octokit = github.getOctokit(token);

  const comment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issueNumber,
    body,
  });

  core.info(`Comment created: ${JSON.stringify(comment)}`);
}

async function run() {
  try {
    const releaseVersion = core.getInput("releaseVersion");

    const repository = core.getInput("repository");
    core.info(`Repository: ${repository}`);
    const [owner, repoName] = repository.split("/");
    core.info(`Owner: ${owner} / Repo: ${repoName}`);

    const clusterName = core.getInput("clusterName");
    const serviceName = core.getInput("serviceName");

    const devEcsKey = core.getInput("devEcsKey");
    const devEcsSecret = core.getInput("devEcsSecret");
    const previewEcsKey = core.getInput("previewEcsKey");
    const previewEcsSecret = core.getInput("previewEcsSecret");
    const productionEcsKey = core.getInput("productionEcsKey");
    const productionEcsSecret = core.getInput("productionEcsSecret");

    const token = core.getInput("token");
    const ref = core.getInput("ref");
    core.info(`Ref: ${ref}`);
    // const issueNumber = ref.split("/")[2];
    // core.info(`PR Number: ${issueNumber}`);

    const prNumber = core.getInput("prNumber");
    core.info(`PR Number: ${prNumber}`);
    const issueNumber = prNumber;

    const event = core.getInput("event");
    core.info(`Event: ${event}`);

    const images = await deploymentFeedback({
      releaseVersion,
      repoName,
      clusterName,
      serviceName,
      devEcsKey,
      devEcsSecret,
      previewEcsKey,
      previewEcsSecret,
      productionEcsKey,
      productionEcsSecret,
    });

    const summary = images.map((i) => {
      const icon = i.willBeReplaced ? "✅" : "❌";
      return `- ${i.env}: ${icon}  (Current image is: ${i.currentImageTag})`;
    });

    const body = `Continuous Delivery Summary for **${releaseVersion}**:
${summary.join("\n")}

_Information valid as ${new Date().toISOString()}_`;

    core.info(`Comment body is: ${body}`);

    await createComment(token, owner, repoName, issueNumber, body);

    core.setOutput("images", JSON.stringify(images));
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
